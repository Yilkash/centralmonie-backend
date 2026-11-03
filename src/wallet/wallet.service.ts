import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { deposits, nairaDeposits, payments, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, formatUsdc, usdcMinorToKobo } from '../money/money';
import { LimitsService } from '../payments/limits.service';
import { ExchangeRates } from '../providers/providers';

export interface WalletSummary {
  address: string | null;
  /** A naira deposit that is on its way, such as ₦2,000, or null. */
  deposit_on_the_way: string | null;
  /** Null when the chain could not be read, which is different from a balance of zero. */
  balance_usdc: string | null;
  balance_naira: string | null;
  limit_used: string;
  limit_left: string;
  naira_per_usdc: number | null;
}

export interface ActivityEntry {
  kind: 'payment' | 'deposit';
  created_at: Date;
  description: string;
  route: string | null;
  recipient: string | null;
  amount_naira: string | null;
  amount_usdc: string;
  status: string;
  tx_hash: string | null;
}

/** Read-only: this service can tell you about money but cannot move any. */
@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly chain: Chain,
    private readonly limits: LimitsService,
    private readonly rates: ExchangeRates,
  ) {}

  async summary(user: User): Promise<WalletSummary> {
    // The balance must still show if the rate cannot be read, so it is shown without its naira value.
    const [used, rate] = await Promise.all([this.limits.usedTodayKobo(user.id), this.rates.nairaPerUsdc().catch(() => null)]);
    const balance = user.walletAddress ? await this.chain.usdcBalance(user.walletAddress).catch(() => null) : null;
    return {
      address: user.walletAddress,
      balance_usdc: balance === null ? null : formatUsdc(Number(balance)),
      balance_naira: balance === null || rate === null ? null : formatNaira(usdcMinorToKobo(Number(balance), rate)),
      limit_used: formatNaira(used),
      limit_left: formatNaira(Math.max(DAILY_LIMIT_KOBO - used, 0)),
      naira_per_usdc: rate,
      deposit_on_the_way: await this.depositOnTheWay(user.id),
    };
  }

  /** Naira the partner has, or that the user says they have sent. Reads our own records, so it is never a balance. */
  private async depositOnTheWay(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ amountKobo: nairaDeposits.amountKobo })
      .from(nairaDeposits)
      .where(
        and(
          eq(nairaDeposits.userId, userId),
          gte(nairaDeposits.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          or(eq(nairaDeposits.status, 'processing'), and(inArray(nairaDeposits.status, ['waiting', 'expired']), isNotNull(nairaDeposits.userSentAt))),
        ),
      )
      .orderBy(desc(nairaDeposits.createdAt))
      .limit(1);
    return row ? formatNaira(row.amountKobo) : null;
  }

  async activity(userId: string, limit = 30): Promise<ActivityEntry[]> {
    const [paid, received] = await Promise.all([
      this.db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(limit),
      this.db.select().from(deposits).where(eq(deposits.userId, userId)).orderBy(desc(deposits.createdAt)).limit(limit),
    ]);
    const entries: ActivityEntry[] = [
      ...paid.map((payment) => ({
        kind: 'payment' as const,
        created_at: payment.createdAt,
        description: `${payment.route} to ${payment.recipientName ?? 'recipient'}`,
        route: payment.route,
        recipient: payment.recipientName,
        amount_naira: formatNaira(payment.amountKobo),
        amount_usdc: formatUsdc(payment.usdcMinor),
        status: payment.status,
        tx_hash: payment.fundingTxHash,
      })),
      ...received.map((deposit) => ({
        kind: 'deposit' as const,
        created_at: deposit.createdAt,
        description: 'Received in your wallet',
        route: null,
        recipient: null,
        amount_naira: null,
        amount_usdc: formatUsdc(deposit.usdcMinor),
        status: 'completed',
        tx_hash: deposit.txHash,
      })),
    ];
    return entries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, limit);
  }
}
