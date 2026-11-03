import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, Database } from '../database/database.module';
import { chatMessages } from '../database/schema';

/** Tells a user something happened, as a message in their chat. Email and push can join here later. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async notify(userId: string, text: string): Promise<void> {
    await this.db.insert(chatMessages).values({ userId, role: 'assistant', content: text, notice: true });
  }
}
