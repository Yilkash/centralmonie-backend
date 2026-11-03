import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { deposits, payments, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, formatUsdc, usdcMinorToKobo } from '../money/money';
import { LimitsService } from '../payments/limits.service';
import { ExchangeRates } from '../providers/providers';

export interface WalletSummary {
  address: string | null;
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
    };
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
