import { Injectable } from '@nestjs/common';
import { ChatMessage, User } from '../database/schema';
import { ChatRepository } from './chat.repository';
import { ChatResponder } from './chat-responder';

const HISTORY_LIMIT = 50;

@Injectable()
export class ChatService {
  constructor(
    private readonly messages: ChatRepository,
    private readonly responder: ChatResponder,
  ) {}

  history(user: User): Promise<ChatMessage[]> {
    return this.messages.recent(user.id, HISTORY_LIMIT);
  }

  /** The user's message is saved first, so a failed reply never loses what they typed. */
  async send(user: User, content: string): Promise<ChatMessage> {
    const history = await this.messages.recent(user.id, HISTORY_LIMIT);
    await this.messages.add(user.id, 'user', content);
    const reply = await this.responder.reply({ user, message: content, history });
    return this.messages.add(user.id, 'assistant', reply);
  }
}
