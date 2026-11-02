import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { ChatMessage, chatMessages } from '../database/schema';

@Injectable()
export class ChatRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async add(
    userId: string,
    role: ChatMessage['role'],
    content: string,
    extra: { planId?: string | undefined; contactId?: string | undefined; hidden?: boolean } = {},
  ): Promise<ChatMessage> {
    const [message] = await this.db
      .insert(chatMessages)
      .values({ userId, role, content, planId: extra.planId ?? null, contactId: extra.contactId ?? null, hidden: extra.hidden ?? false })
      .returning();
    return message!;
  }

  /** The newest messages, returned oldest first. */
  async recent(userId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(limit);
    return rows.reverse();
  }
}
