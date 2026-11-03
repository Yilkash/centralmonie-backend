import { ChatMessage, User } from '../database/schema';
import { ChatRepository } from './chat.repository';
import { ChatReply, ChatResponder, ChatTurn } from './chat-responder';
import { ChatService } from './chat.service';

const user = { id: 'user-1' } as User;

class FakeRepository {
  saved: Pick<ChatMessage, 'role' | 'content'>[] = [];
  async sentSince() {
    return 0;
  }

  async add(_userId: string, role: ChatMessage['role'], content: string) {
    this.saved.push({ role, content });
    return { role, content } as ChatMessage;
  }
  async recent() {
    return [...this.saved] as ChatMessage[];
  }
}

function serviceWith(reply: (turn: ChatTurn) => Promise<ChatReply>) {
  const repository = new FakeRepository();
  const responder = { reply } as ChatResponder;
  return { repository, service: new ChatService(repository as unknown as ChatRepository, responder) };
}

describe('ChatService', () => {
  it('saves the message and the reply in order', async () => {
    const { repository, service } = serviceWith(async () => ({ text: 'hello back' }));
    const answer = await service.send(user, 'hello');
    expect(answer.content).toBe('hello back');
    expect(repository.saved).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hello back' },
    ]);
  });

  it('gives the responder earlier messages, without the new one', async () => {
    const reply = jest.fn(async (_turn: ChatTurn) => ({ text: 'ok' }));
    const { repository, service } = serviceWith(reply);
    repository.saved.push({ role: 'user', content: 'earlier' });
    await service.send(user, 'new');
    const turn = reply.mock.calls[0]![0];
    expect(turn.message).toBe('new');
    expect(turn.history.at(-1)?.content).toBe('earlier');
  });

  it('keeps the message when the reply fails', async () => {
    const { repository, service } = serviceWith(async () => {
      throw new Error('responder down');
    });
    await expect(service.send(user, 'hello')).rejects.toThrow('responder down');
    expect(repository.saved).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
