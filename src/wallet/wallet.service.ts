import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
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

const ROUTE_LABEL: Record<string, string> = { bank: 'Bank transfer', airtime: 'Airtime', data: 'Data', usdc: 'USDC transfer' };

/** What a shareable receipt shows. Numbers are masked because these get sent to other people. */
export interface Receipt {
  reference: string;
  kind: string;
  title: string;
  recipient: string | null;
  recipient_detail: string | null;
  amount: string;
  /** The other currency, marked approximate where the partner sets the final figure. */
  second_amount: string | null;
  note: string | null;
  completed_at: Date;
  tx_hash: string | null;
}

const mask = (value: string, keep = 4) => `****${value.slice(-keep)}`;

function maskedDestination(destination: unknown): string | null {
  const d = destination as { kind?: string; phone?: string | null; network?: string | null; accountName?: string | null; bankName?: string | null; accountNumber?: string | null; walletAddress?: string | null } | null;
  if (d?.kind === 'bank' && d.accountNumber) return `${d.accountName ?? ''}, ${d.bankName ?? 'Bank'} ${mask(d.accountNumber)}`.replace(/^, /, '');
  if (d?.kind === 'phone' && d.phone) return `${d.phone.slice(0, 4)}${mask(d.phone, 3)}${d.network ? ` (${d.network})` : ''}`;
  if (d?.kind === 'wallet' && d.walletAddress) return `${d.walletAddress.slice(0, 6)}…${d.walletAddress.slice(-4)}`;
  return null;
}

export interface ActivityPage {
  activity: ActivityEntry[];
  page: number;
  per_page: number;
  total: number;
}

export interface ActivityEntry {
  id: string;
  /** Whether this finished for real, so a receipt can be made for it. */
  has_receipt: boolean;
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

  /** One page, newest first, across payments and money received. */
  async activityPage(userId: string, page: number, perPage: number): Promise<ActivityPage> {
    const [[paidCount], [receivedCount]] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(payments).where(eq(payments.userId, userId)),
      this.db.select({ count: sql<number>`count(*)::int` }).from(deposits).where(eq(deposits.userId, userId)),
    ]);
    const entries = await this.activity(userId, page * perPage);
    return {
      activity: entries.slice((page - 1) * perPage, page * perPage),
      page,
      per_page: perPage,
      total: (paidCount?.count ?? 0) + (receivedCount?.count ?? 0),
    };
  }

  /** Only for the user's own finished transactions. Anything else is treated as not there. */
  async receipt(userId: string, kind: 'payment' | 'deposit', id: string): Promise<Receipt | null> {
    if (kind === 'deposit') {
      const [deposit] = await this.db.select().from(deposits).where(and(eq(deposits.id, id), eq(deposits.userId, userId)));
      if (!deposit) return null;
      return {
        reference: deposit.id,
        kind: 'Deposit',
        title: 'Money received',
        recipient: null,
        recipient_detail: null,
        amount: formatUsdc(deposit.usdcMinor),
        second_amount: null,
        note: null,
        completed_at: deposit.createdAt,
        tx_hash: deposit.txHash,
      };
    }
    const [payment] = await this.db.select().from(payments).where(and(eq(payments.id, id), eq(payments.userId, userId)));
    if (!payment || payment.status !== 'completed' || payment.providerReference?.startsWith('simulated-')) return null;
    const usdc = payment.route === 'usdc';
    return {
      reference: payment.id,
      kind: ROUTE_LABEL[payment.route] ?? 'Payment',
      title: 'Payment successful',
      recipient: payment.recipientName,
      recipient_detail: maskedDestination(payment.destination),
      amount: usdc ? formatUsdc(payment.usdcMinor) : formatNaira(payment.amountKobo),
      second_amount: usdc ? null : formatUsdc(payment.usdcMinor),
      // The partner sets the exact naira from the rate when it pays out, so the quote can differ by a little.
      note: payment.route === 'bank' ? 'Naira shown is the quoted amount. The exact figure is on the bank alert.' : null,
      completed_at: payment.createdAt,
      tx_hash: payment.fundingTxHash,
    };
  }

  async activity(userId: string, limit = 30): Promise<ActivityEntry[]> {
    const [paid, received] = await Promise.all([
      this.db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(limit),
      this.db.select().from(deposits).where(eq(deposits.userId, userId)).orderBy(desc(deposits.createdAt)).limit(limit),
    ]);
    const entries: ActivityEntry[] = [
      ...paid.map((payment) => ({
        id: payment.id,
        has_receipt: payment.status === 'completed' && !payment.providerReference?.startsWith('simulated-'),
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
        id: deposit.id,
        has_receipt: true,
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
