import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { Chain } from '../chain/chain.service';
import { chainOfWallet } from '../chain/usdc-chains';
import { DATABASE, Database } from '../database/database.module';
import { agentPayments, deposits, nairaDeposits, payLinks, payments, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, formatUsdc, usdcMinorToKobo } from '../money/money';
import { LimitsService } from '../payments/limits.service';
import { ExchangeRates } from '../providers/providers';

export interface WalletSummary {
  address: string | null;
  /** A naira deposit that is on its way, such as ₦2,000, or null. */
  deposit_on_the_way: string | null;
  /** The newest transaction, to show beside the balance. */
  latest: ActivityEntry | null;
  /** Null when the chain could not be read, which is different from a balance of zero. */
  balance_usdc: string | null;
  balance_naira: string | null;
  limit_used: string;
  limit_left: string;
  naira_per_usdc: number | null;
}

const ROUTE_LABEL: Record<string, string> = { bank: 'Bank transfer', airtime: 'Airtime', data: 'Data', usdc: 'USDC transfer' };

/** What a shareable receipt shows. Numbers are masked because these get sent to other people. */
/** The chain a USDC payment was delivered on, when it is not the one the wallet is on. */
function crossChainName(destination: unknown): string | null {
  const chain = chainOfWallet(destination as { walletAddress?: string; network?: string | null });
  return chain.key === 'base' ? null : chain.name;
}

export interface Receipt {
  reference: string;
  kind: string;
  title: string;
  recipient: string | null;
  recipient_detail: string | null;
  /** The network the USDC moved on. Null when it ended as naira or airtime. */
  network: string | null;
  amount: string;
  /** The other currency, marked approximate where the partner sets the final figure. */
  second_amount: string | null;
  note: string | null;
  completed_at: Date;
  tx_hash: string | null;
  /** For USDC sent on to another network: what arrived there, and the transaction that delivered it. */
  received?: string | null;
  delivery_tx_hash?: string | null;
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
  direction: 'in' | 'out';
  /** bank, airtime, data, usdc or deposit. */
  type: string;
  type_label: string;
  created_at: Date;
  description: string;
  /** Masked, so it is safe to show and to export. */
  detail: string | null;
  route: string | null;
  recipient: string | null;
  amount_naira: string | null;
  amount_usdc: string;
  status: string;
  tx_hash: string | null;
}

export interface ActivityFilters {
  direction?: 'in' | 'out' | undefined;
  type?: string | undefined;
  search?: string | undefined;
  /** Days in Nigerian time, such as 2026-11-03. */
  from?: string | undefined;
  to?: string | undefined;
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const shortenAddresses = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, shortAddress);

function describePayment(route: string, name: string | null): string {
  const who = shortenAddresses(name ?? 'recipient');
  if (route === 'airtime') return `Airtime for ${who}`;
  if (route === 'data') return `Data for ${who}`;
  if (route === 'usdc') return who.startsWith('0x') ? `Sent to wallet ${who}` : `Sent USDC to ${who}`;
  return `Sent to ${who}`;
}

/** A value for a spreadsheet: quoted, and unable to run as a formula when someone opens the file. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const CSV_LIMIT = 5000;

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
    // All at once, so the page waits for the slowest lookup instead of the sum of them.
    const [used, rate, balance, depositOnTheWay, [latest]] = await Promise.all([
      this.limits.usedTodayKobo(user.id),
      this.rates.nairaPerUsdc().catch(() => null),
      user.walletAddress ? this.chain.usdcBalance(user.walletAddress).catch(() => null) : Promise.resolve(null),
      this.depositOnTheWay(user.id),
      this.entries(user.id, {}, 1),
    ]);
    return {
      address: user.walletAddress,
      balance_usdc: balance === null ? null : formatUsdc(Number(balance)),
      balance_naira: balance === null || rate === null ? null : formatNaira(usdcMinorToKobo(Number(balance), rate)),
      limit_used: formatNaira(used),
      limit_left: formatNaira(Math.max(DAILY_LIMIT_KOBO - used, 0)),
      naira_per_usdc: rate,
      deposit_on_the_way: depositOnTheWay,
      latest: latest ?? null,
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

  private paymentConditions(userId: string, filters: ActivityFilters) {
    const search = filters.search?.trim();
    return and(
      eq(payments.userId, userId),
      filters.type && filters.type !== 'deposit' && filters.type !== 'pay_link' ? eq(payments.route, filters.type as 'bank' | 'airtime' | 'data' | 'usdc') : undefined,
      search ? ilike(payments.recipientName, `%${search.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
      filters.from ? gte(payments.createdAt, new Date(`${filters.from}T00:00:00+01:00`)) : undefined,
      filters.to ? lte(payments.createdAt, new Date(`${filters.to}T23:59:59.999+01:00`)) : undefined,
    );
  }

  private depositConditions(userId: string, filters: ActivityFilters) {
    const search = filters.search?.trim().toLowerCase();
    // Words people would look for on these rows, or the wallet the money came from.
    const byWord = search && ('received deposit deposited'.includes(search) ? undefined : ilike(deposits.fromAddress, `%${search.replace(/[%_\\]/g, '\\$&')}%`));
    return and(
      eq(deposits.userId, userId),
      byWord || undefined,
      filters.from ? gte(deposits.createdAt, new Date(`${filters.from}T00:00:00+01:00`)) : undefined,
      filters.to ? lte(deposits.createdAt, new Date(`${filters.to}T23:59:59.999+01:00`)) : undefined,
    );
  }

  private wants(filters: ActivityFilters) {
    return {
      payments: filters.direction !== 'in' && filters.type !== 'deposit' && filters.type !== 'pay_link',
      deposits: filters.direction !== 'out' && (!filters.type || filters.type === 'deposit' || filters.type === 'pay_link'),
    };
  }

  /** Pay links this user made that someone has really paid. */
  private async paidLinks(userId: string, filters: ActivityFilters) {
    return this.db
      .select({ link: payLinks, payment: agentPayments })
      .from(payLinks)
      .innerJoin(agentPayments, eq(payLinks.paymentId, agentPayments.id))
      .where(
        and(
          eq(payLinks.userId, userId),
          eq(agentPayments.status, 'paid'),
          filters.from ? gte(agentPayments.createdAt, new Date(`${filters.from}T00:00:00+01:00`)) : undefined,
          filters.to ? lte(agentPayments.createdAt, new Date(`${filters.to}T23:59:59.999+01:00`)) : undefined,
        ),
      );
  }

  /** Newest first, across payments and money received. */
  private async entries(userId: string, filters: ActivityFilters, limit: number): Promise<ActivityEntry[]> {
    const wanted = this.wants(filters);
    const links = wanted.deposits && filters.type !== 'deposit' && !filters.search ? await this.paidLinks(userId, filters) : [];
    const [paid, received, naira] = await Promise.all([
      wanted.payments ? this.db.select().from(payments).where(this.paymentConditions(userId, filters)).orderBy(desc(payments.createdAt)).limit(limit) : [],
      wanted.deposits && filters.type !== 'pay_link' ? this.db.select().from(deposits).where(this.depositConditions(userId, filters)).orderBy(desc(deposits.createdAt)).limit(limit) : [],
      wanted.deposits && filters.type !== 'pay_link' ? this.db.select().from(nairaDeposits).where(and(eq(nairaDeposits.userId, userId), eq(nairaDeposits.status, 'completed'))).orderBy(desc(nairaDeposits.createdAt)).limit(200) : [],
    ]);
    // A naira deposit reaches the wallet as a USDC transfer. Each is matched once, by amount and time.
    const unmatched = [...naira];
    const naming = new Map<string, string>();
    for (const deposit of received) {
      const index = unmatched.findIndex(
        (row) => Math.abs(row.usdcMinor - deposit.usdcMinor) <= row.usdcMinor * 0.02 && Math.abs(deposit.createdAt.getTime() - (row.completedAt ?? row.createdAt).getTime()) < 86_400_000,
      );
      if (index >= 0) naming.set(deposit.id, formatNaira(unmatched.splice(index, 1)[0]!.amountKobo));
    }
    const entries: ActivityEntry[] = [
      ...links.map(({ link, payment }) => ({
        id: payment.id,
        has_receipt: false,
        kind: 'payment' as const,
        direction: 'in' as const,
        type: 'pay_link',
        type_label: 'Pay link',
        created_at: payment.paidAt ?? payment.createdAt,
        description: link.note ? `Paid by link: ${link.note}` : 'Paid by link',
        detail: link.nearAccount ?? link.usdcAddress ?? `${link.bankName} ****${link.accountNumber.slice(-4)}`,
        route: null,
        recipient: payment.payerName,
        amount_naira: formatNaira(payment.payoutKobo ?? payment.amountKobo),
        amount_usdc: formatUsdc(payment.usdcMinor),
        status: 'completed',
        tx_hash: [...payment.transactions].reverse().find((hash) => hash.startsWith('0x')) ?? payment.transactions.at(-1) ?? null,
      })),
      ...paid.map((payment) => ({
        id: payment.id,
        has_receipt: payment.status === 'completed' && !payment.providerReference?.startsWith('simulated-'),
        kind: 'payment' as const,
        direction: 'out' as const,
        type: payment.route,
        type_label: ROUTE_LABEL[payment.route] ?? 'Payment',
        created_at: payment.createdAt,
        description: describePayment(payment.route, payment.recipientName),
        detail: maskedDestination(payment.destination),
        route: payment.route,
        recipient: payment.recipientName,
        amount_naira: formatNaira(payment.amountKobo),
        amount_usdc: formatUsdc(payment.usdcMinor),
        status: payment.status,
        tx_hash: payment.fundingTxHash,
      })),
      ...received.map((deposit) => {
        const paidIn = naming.get(deposit.id);
        return {
          id: deposit.id,
          has_receipt: true,
          kind: 'deposit' as const,
          direction: 'in' as const,
          type: 'deposit',
          type_label: paidIn ? 'Naira deposit' : 'USDC received',
          created_at: deposit.createdAt,
          description: paidIn ? `Deposited ${paidIn}` : `Received from ${shortAddress(deposit.fromAddress)}`,
          detail: paidIn ? null : `From ${shortAddress(deposit.fromAddress)}`,
          route: null,
          recipient: null,
          amount_naira: null,
          amount_usdc: formatUsdc(deposit.usdcMinor),
          status: 'completed',
          tx_hash: deposit.txHash,
        };
      }),
    ];
    return entries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, limit);
  }

  /** One page of what matches the filters. */
  async activityPage(userId: string, page: number, perPage: number, filters: ActivityFilters = {}): Promise<ActivityPage> {
    const wanted = this.wants(filters);
    const count = sql<number>`count(*)::int`;
    const [[paidCount], [receivedCount]] = await Promise.all([
      wanted.payments ? this.db.select({ count }).from(payments).where(this.paymentConditions(userId, filters)) : [{ count: 0 }],
      wanted.deposits && filters.type !== 'pay_link' ? this.db.select({ count }).from(deposits).where(this.depositConditions(userId, filters)) : [{ count: 0 }],
    ]);
    const entries = await this.entries(userId, filters, page * perPage);
    const linkCount = wanted.deposits && filters.type !== 'deposit' && !filters.search ? (await this.paidLinks(userId, filters)).length : 0;
    return {
      activity: entries.slice((page - 1) * perPage, page * perPage),
      page,
      per_page: perPage,
      total: (paidCount?.count ?? 0) + (receivedCount?.count ?? 0) + linkCount,
    };
  }

  /** What matches the filters, as a spreadsheet file. */
  async activityCsv(userId: string, filters: ActivityFilters = {}): Promise<string> {
    const rows = await this.entries(userId, filters, CSV_LIMIT);
    const header = ['Date', 'Description', 'Type', 'Details', 'Status', 'Direction', 'Naira', 'USDC', 'Transaction'];
    const body = rows.map((row) =>
      [
        new Date(row.created_at.getTime() + 3_600_000).toISOString().slice(0, 16).replace('T', ' '),
        row.description,
        row.type_label,
        row.detail ?? '',
        row.status,
        row.direction === 'in' ? 'Money in' : 'Money out',
        row.amount_naira ?? '',
        row.amount_usdc,
        row.tx_hash ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...body].join('\r\n') + '\r\n';
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
        network: this.chain.networkName(),
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
    const wallet = (payment.destination as { walletAddress?: string | null } | null)?.walletAddress ?? null;
    const chain = usdc ? chainOfWallet(payment.destination as { walletAddress?: string; network?: string | null }) : null;
    const elsewhere = chain !== null && chain.key !== 'base';
    // A wallet saved under its own address would say the address twice, once cut short, so it is said once in full.
    const namedByAddress = Boolean(wallet && payment.recipientName === wallet);
    return {
      reference: payment.id,
      kind: ROUTE_LABEL[payment.route] ?? 'Payment',
      title: 'Payment successful',
      recipient: payment.recipientName,
      recipient_detail: namedByAddress ? null : maskedDestination(payment.destination),
      network: usdc ? (crossChainName(payment.destination) ?? this.chain.networkName()) : null,
      amount: usdc ? formatUsdc(payment.usdcMinor) : formatNaira(payment.amountKobo),
      second_amount: usdc ? null : formatUsdc(payment.usdcMinor),
      // The partner sets the exact naira from the rate when it pays out, so the quote can differ by a little.
      note: payment.route === 'bank' ? 'Naira shown is the quoted amount. The exact figure is on the bank alert.' : null,
      completed_at: payment.createdAt,
      tx_hash: payment.fundingTxHash,
      received: elsewhere && payment.deliveredMinor ? formatUsdc(payment.deliveredMinor).replace('USDC', chain!.token) : null,
      delivery_tx_hash: elsewhere && payment.providerReference && payment.providerReference !== payment.fundingAddress ? payment.providerReference : null,
    };
  }

  /** For the agent: the latest transactions, unfiltered. */
  activity(userId: string, limit = 30): Promise<ActivityEntry[]> {
    return this.entries(userId, {}, limit);
  }
}
