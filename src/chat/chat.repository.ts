import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { ChatMessage, chatMessages, Conversation, conversations } from '../database/schema';

type Extra = {
  planId?: string | undefined;
  contactId?: string | undefined;
  scheduleGroupId?: string | undefined;
  cancelScheduleId?: string | undefined;
  depositId?: string | undefined;
  hidden?: boolean;
};

const TITLE_LENGTH = 48;

/** A short name from the first message, cut at a word. */
export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_LENGTH) return clean || 'New chat';
  const cut = clean.slice(0, TITLE_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

@Injectable()
export class ChatRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async add(userId: string, conversationId: string, role: ChatMessage['role'], content: string, extra: Extra = {}): Promise<ChatMessage> {
    const [message] = await this.db
      .insert(chatMessages)
      .values({
        userId,
        conversationId,
        role,
        content,
        planId: extra.planId ?? null,
        contactId: extra.contactId ?? null,
        scheduleGroupId: extra.scheduleGroupId ?? null,
        cancelScheduleId: extra.cancelScheduleId ?? null,
        depositId: extra.depositId ?? null,
        hidden: extra.hidden ?? false,
      })
      .returning();
    await this.db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    return message!;
  }

  async sentSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(and(eq(chatMessages.userId, userId), eq(chatMessages.role, 'user'), gte(chatMessages.createdAt, since)));
    return row?.count ?? 0;
  }

  /** The newest messages of one chat, returned oldest first. */
  async recent(conversationId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(limit);
    return rows.reverse();
  }

  async createConversation(userId: string, title: string): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values({ userId, title }).returning();
    return row!;
  }

  conversations(userId: string, limit = 100): Promise<Conversation[]> {
    return this.db.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.updatedAt)).limit(limit);
  }

  /** Only ever finds the user's own chat. */
  async conversation(userId: string, id: string): Promise<Conversation | null> {
    const [row] = await this.db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
    return row ?? null;
  }

  async renameConversation(userId: string, id: string, title: string): Promise<boolean> {
    const rows = await this.db.update(conversations).set({ title }).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).returning({ id: conversations.id });
    return rows.length > 0;
  }

  /** Removes the chat and its messages. Payments and schedules are separate records, so they are untouched. */
  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).returning({ id: conversations.id });
    return rows.length > 0;
  }

  async latestConversation(userId: string): Promise<Conversation | null> {
    const [row] = await this.conversations(userId, 1);
    return row ?? null;
  }
}
