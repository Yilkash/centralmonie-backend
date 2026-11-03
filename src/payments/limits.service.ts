import { Inject, Injectable } from '@nestjs/common';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { payments } from '../database/schema';
import { DAILY_LIMIT_KOBO } from '../money/money';

// The start of today in Nigeria, whatever time zone the server runs in.
const startOfLagosDay = sql`(date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`;

/** Daily spending is added up from the payments themselves, so there is no second number to drift. */
@Injectable()
export class LimitsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async usedTodayKobo(userId: string, db: Pick<Database, 'select'> = this.db): Promise<number> {
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${payments.amountKobo}), 0)` })
      .from(payments)
      .where(and(eq(payments.userId, userId), notInArray(payments.status, ['failed', 'returned']), sql`${payments.createdAt} >= ${startOfLagosDay}`));
    return Number(row!.used);
  }

  async leftTodayKobo(userId: string, db: Pick<Database, 'select'> = this.db): Promise<number> {
    return Math.max(DAILY_LIMIT_KOBO - (await this.usedTodayKobo(userId, db)), 0);
  }
}
