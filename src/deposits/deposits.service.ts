import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { NairaDeposit, nairaDeposits, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../ops/audit.service';
import { SwitchesService } from '../ops/switches.service';
import { NairaOnramp } from '../providers/providers';

const WATCH_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_A_DAY = 10;
const UNAVAILABLE = 'Naira deposits are not available right now. Please try again later.';

/** Naira in, USDC out. We only hold the instructions and report progress, so no money of ours moves here. */
@Injectable()
export class NairaDepositsService {
  private readonly logger = new Logger(NairaDepositsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NairaOnramp) private readonly partner: NairaOnramp | null,
    private readonly notifications: NotificationsService,
    private readonly switches: SwitchesService,
    private readonly audit: AuditService,
  ) {}

  private live(): NairaOnramp {
    if (!this.partner) throw new ServiceUnavailableException(UNAVAILABLE);
    return this.partner;
  }

  async terms(): Promise<{ nairaPerUsdc: number; minimumKobo: number; maximumKobo: number }> {
    const terms = await this.live().onrampTerms().catch(() => {
      throw new ServiceUnavailableException(UNAVAILABLE);
    });
    return { ...terms, maximumKobo: DAILY_LIMIT_KOBO };
  }

  /** A deposit still waiting for its transfer is returned as it is, so one person has one account to pay at a time. */
  async start(user: User, naira: number): Promise<NairaDeposit> {
    const partner = this.live();
    if (!user.walletAddress) throw new UnprocessableEntityException('Your wallet is still being set up. Please try again in a moment.');
    if ((await this.switches.isPaused('payments')) || (await this.switches.isPaused('deposits'))) throw new ServiceUnavailableException(UNAVAILABLE);

    const open = await this.waiting(user.id);
    if (open) return open;

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(nairaDeposits)
      .where(and(eq(nairaDeposits.userId, user.id), gte(nairaDeposits.createdAt, new Date(Date.now() - WATCH_FOR_MS))));
    if (count >= MAX_A_DAY) throw new UnprocessableEntityException('You have started too many deposits today. Please try again tomorrow.');

    const { minimumKobo, maximumKobo } = await this.terms();
    const amountKobo = naira * 100;
    if (amountKobo < minimumKobo) throw new UnprocessableEntityException(`The smallest deposit is ${formatNaira(minimumKobo)}.`);
    if (amountKobo > maximumKobo) throw new UnprocessableEntityException(`The largest deposit is ${formatNaira(maximumKobo)}.`);

    const id = randomUUID();
    const order = await partner.nairaOnramp({ reference: id, amountKobo, walletAddress: user.walletAddress }).catch((error: Error) => {
      this.logger.warn(`deposit ${id} refused: ${error.message.slice(0, 200)}`);
      throw new UnprocessableEntityException(UNAVAILABLE);
    });
    // Without a deadline we could not show a true countdown, so this account is not handed out.
    const expiresAt = order.expiresAt ? new Date(order.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) throw new UnprocessableEntityException(UNAVAILABLE);

    const [saved] = await this.db
      .insert(nairaDeposits)
      .values({
        id,
        userId: user.id,
        amountKobo: order.amountKobo,
        usdcMinor: order.usdcMinor,
        rate: order.rate,
        bankName: order.bankName,
        accountNumber: order.accountNumber,
        accountName: order.accountName,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!saved) {
      // Two taps at once: the other one won, and its account is the one to show.
      const other = await this.waiting(user.id);
      if (other) return other;
      throw new UnprocessableEntityException(UNAVAILABLE);
    }
    await this.audit.record(user.id, 'deposit.started', id);
    return saved;
  }

  private async waiting(userId: string): Promise<NairaDeposit | null> {
    const [row] = await this.db
      .select()
      .from(nairaDeposits)
      .where(and(eq(nairaDeposits.userId, userId), eq(nairaDeposits.status, 'waiting')));
    return row ?? null;
  }

  /** The newest deposit from the last day that the user has not put aside. */
  async current(userId: string): Promise<NairaDeposit | null> {
    const [row] = await this.db
      .select()
      .from(nairaDeposits)
      .where(and(eq(nairaDeposits.userId, userId), ne(nairaDeposits.status, 'cancelled'), gte(nairaDeposits.createdAt, new Date(Date.now() - WATCH_FOR_MS))))
      .orderBy(desc(nairaDeposits.createdAt))
      .limit(1);
    return row ?? null;
  }

  async get(userId: string, id: string): Promise<NairaDeposit | null> {
    const [row] = await this.db.select().from(nairaDeposits).where(and(eq(nairaDeposits.id, id), eq(nairaDeposits.userId, userId)));
    return row ?? null;
  }

  async markSent(userId: string, id: string): Promise<void> {
    const updated = await this.db
      .update(nairaDeposits)
      .set({ userSentAt: new Date() })
      .where(and(eq(nairaDeposits.id, id), eq(nairaDeposits.userId, userId), inArray(nairaDeposits.status, ['waiting', 'expired'])))
      .returning({ id: nairaDeposits.id });
    if (updated.length === 0) throw new NotFoundException('That deposit is not waiting for a transfer.');
  }

  /** Puts it aside so another can start. We keep watching it, because a transfer may already be on its way. */
  async cancel(userId: string, id: string): Promise<void> {
    const updated = await this.db
      .update(nairaDeposits)
      .set({ status: 'cancelled' })
      .where(and(eq(nairaDeposits.id, id), eq(nairaDeposits.userId, userId), inArray(nairaDeposits.status, ['waiting', 'expired', 'failed', 'completed'])))
      .returning({ id: nairaDeposits.id });
    if (updated.length === 0) throw new NotFoundException('That deposit cannot be closed.');
  }

  /** Reads each open deposit from the partner. Only ever moves a row forward, and tells the user once per step. */
  async reconcile(): Promise<void> {
    if (!this.partner) return;
    const open = await this.db
      .select()
      .from(nairaDeposits)
      .where(and(inArray(nairaDeposits.status, ['waiting', 'processing', 'expired', 'cancelled']), gte(nairaDeposits.createdAt, new Date(Date.now() - WATCH_FOR_MS))))
      .orderBy(desc(nairaDeposits.createdAt))
      .limit(50);
    for (const deposit of open) {
      const state = await this.partner.onrampState(deposit.id);
      await this.apply(deposit, state);
    }
  }

  private async move(deposit: NairaDeposit, status: NairaDeposit['status'], completed = false): Promise<boolean> {
    const updated = await this.db
      .update(nairaDeposits)
      .set({ status, ...(completed ? { completedAt: new Date() } : {}) })
      .where(and(eq(nairaDeposits.id, deposit.id), eq(nairaDeposits.status, deposit.status)))
      .returning({ id: nairaDeposits.id });
    return updated.length > 0;
  }

  private async apply(deposit: NairaDeposit, state: Awaited<ReturnType<NairaOnramp['onrampState']>>): Promise<void> {
    const amount = formatNaira(deposit.amountKobo);
    switch (state) {
      case 'completed':
        if (await this.move(deposit, 'completed', true)) await this.notifications.notify(deposit.userId, `Your ${amount} deposit is complete.`);
        return;
      case 'processing':
        if (deposit.status !== 'processing' && (await this.move(deposit, 'processing'))) {
          await this.notifications.notify(deposit.userId, `We have received your ${amount}. Your USDC is on the way.`);
        }
        return;
      case 'failed':
        if (deposit.status === 'processing' && (await this.move(deposit, 'failed'))) {
          await this.notifications.notify(deposit.userId, `Your ${amount} deposit could not be completed. Please contact support if money left your bank.`);
        }
        return;
      case 'expired':
        if (deposit.status === 'waiting') await this.move(deposit, 'expired');
        return;
      case 'waiting':
        if (deposit.status === 'waiting' && deposit.expiresAt.getTime() <= Date.now()) await this.move(deposit, 'expired');
        return;
      case 'unknown':
        return;
    }
  }
}

