import { HttpException, Injectable } from '@nestjs/common';
import { ChatMessage, User } from '../database/schema';
import { ChatRepository } from './chat.repository';
import { ChatResponder } from './chat-responder';

const HISTORY_LIMIT = 50;
// Each message costs money at the model, so one account cannot run up the bill.
const MAX_PER_MINUTE = 20;
const MAX_PER_DAY = 500;

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
  async send(user: User, content: string, options: { hidden?: boolean } = {}): Promise<ChatMessage> {
    if ((await this.messages.sentSince(user.id, new Date(Date.now() - 60_000))) >= MAX_PER_MINUTE) {
      throw new HttpException('You are sending messages very fast. Please wait a moment.', 429);
    }
    if ((await this.messages.sentSince(user.id, new Date(Date.now() - 86_400_000))) >= MAX_PER_DAY) {
      throw new HttpException('You have reached the message limit for today.', 429);
    }
    const history = await this.messages.recent(user.id, HISTORY_LIMIT);
    await this.messages.add(user.id, 'user', content, options);
    const reply = await this.responder.reply({ user, message: content, history });
    return this.messages.add(user.id, 'assistant', reply.text, {
      planId: reply.planId,
      contactId: reply.contactId,
      scheduleGroupId: reply.scheduleGroupId,
      cancelScheduleId: reply.cancelScheduleId,
    });
  }
}
