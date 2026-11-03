import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ChatMessage, Conversation, User } from '../database/schema';
import { ChatRepository, titleFrom } from './chat.repository';
import { ChatResponder } from './chat-responder';

const HISTORY_LIMIT = 50;
// Each message costs money at the model, so one account cannot run up the bill.
const MAX_PER_MINUTE = 20;
const MAX_PER_DAY = 500;

/** Which chat a message belongs to: a given one, a brand new one, or by default the latest. */
export type ChatTarget = { conversationId?: string | undefined; startNew?: boolean | undefined };

@Injectable()
export class ChatService {
  constructor(
    private readonly messages: ChatRepository,
    private readonly responder: ChatResponder,
  ) {}

  conversations(user: User): Promise<Conversation[]> {
    return this.messages.conversations(user.id);
  }

  private async owned(user: User, id: string): Promise<Conversation> {
    const conversation = await this.messages.conversation(user.id, id);
    if (!conversation) throw new NotFoundException('Chat not found');
    return conversation;
  }

  async history(user: User, conversationId?: string): Promise<ChatMessage[]> {
    const conversation = conversationId ? await this.owned(user, conversationId) : await this.messages.latestConversation(user.id);
    return conversation ? this.messages.recent(conversation.id, HISTORY_LIMIT) : [];
  }

  /** The user's message is saved first, so a failed reply never loses what they typed. */
  async send(user: User, content: string, target: ChatTarget = {}, options: { hidden?: boolean } = {}): Promise<ChatMessage> {
    if ((await this.messages.sentSince(user.id, new Date(Date.now() - 60_000))) >= MAX_PER_MINUTE) {
      throw new HttpException('You are sending messages very fast. Please wait a moment.', 429);
    }
    if ((await this.messages.sentSince(user.id, new Date(Date.now() - 86_400_000))) >= MAX_PER_DAY) {
      throw new HttpException('You have reached the message limit for today.', 429);
    }
    const existing = target.conversationId
      ? await this.owned(user, target.conversationId)
      : target.startNew
        ? null
        : await this.messages.latestConversation(user.id);
    const conversation = existing ?? (await this.messages.createConversation(user.id, titleFrom(content)));
    const history = await this.messages.recent(conversation.id, HISTORY_LIMIT);
    await this.messages.add(user.id, conversation.id, 'user', content, options);
    const reply = await this.responder.reply({ user, message: content, history });
    return this.messages.add(user.id, conversation.id, 'assistant', reply.text, {
      planId: reply.planId,
      contactId: reply.contactId,
      scheduleGroupId: reply.scheduleGroupId,
      cancelScheduleId: reply.cancelScheduleId,
      depositId: reply.depositId,
    });
  }
}
