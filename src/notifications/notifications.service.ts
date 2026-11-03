import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { chatMessages, conversations } from '../database/schema';

/** Tells a user something happened, as a message in their latest chat. Email and push can join here later. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async notify(userId: string, text: string, txHash?: string | null): Promise<void> {
    const [latest] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.updatedAt)).limit(1);
    const conversationId = latest?.id ?? (await this.db.insert(conversations).values({ userId, title: 'Updates' }).returning({ id: conversations.id }))[0]!.id;
    await this.db.insert(chatMessages).values({ userId, conversationId, role: 'assistant', content: text, notice: true, txHash: txHash ?? null });
    await this.db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  }
}
