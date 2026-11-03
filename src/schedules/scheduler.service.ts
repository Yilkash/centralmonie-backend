import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { SpendPermission } from '../chain/chain';
import { Chain, SpendRefused } from '../chain/chain.service';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { Payment, payments, Schedule, scheduleRuns, schedules, users } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, formatUsdc, koboToUsdcMinor } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';
import { LimitsService } from '../payments/limits.service';
import { PaymentEngine } from '../payments/payment-engine.service';
import { ExchangeRates, PaymentProvider } from '../providers/providers';
import { GuardsService } from '../ops/guards.service';
import { SwitchesService } from '../ops/switches.service';
import { SchedulesService } from './schedules.service';
import { describeMoment, nextRun, Timing } from './timing';

const LEASE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const REMINDER_BEFORE_MS = DAY_MS;

type Attempt = { ok: true; payment: Payment } | { ok: false; reason: string; notify: string };

const amountOf = (schedule: Schedule): string =>
  schedule.fixedUsdcMinor !== null ? formatUsdc(schedule.fixedUsdcMinor) : formatNaira(schedule.amountKobo);
const labelOf = (schedule: Schedule): string => {
  const what = { airtime: 'airtime', data: `${schedule.dataPlan ?? ''} data`.trim(), bank: 'bank transfer', usdc: 'transfer' }[schedule.route];
  return `${amountOf(schedule)} ${what} to ${schedule.recipientName}`;
};

/** Runs due payments on a timer. There is no AI in this file, and it pays only what the user approved. */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly schedulesService: SchedulesService,
    private readonly chain: Chain,
    private readonly provider: PaymentProvider,
    private readonly rates: ExchangeRates,
    private readonly limits: LimitsService,
    private readonly engine: PaymentEngine,
    private readonly notifications: NotificationsService,
    private readonly switches: SwitchesService,
    private readonly guards: GuardsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get onChain(): boolean {
    return this.config.get('PAYMENTS_MODE', { infer: true }) === 'chain';
  }

  async tick(now = new Date()): Promise<void> {
    await this.remind(now);
    if (await this.switches.isPaused('schedules')) return;
    for (const schedule of await this.schedulesService.claimDue(now, LEASE_MS)) {
      try {
        await this.run(schedule, now);
      } catch (error) {
        this.logger.error(`Schedule ${schedule.id} failed: ${(error as Error).name}`);
      }
    }
  }

  private async remind(now: Date): Promise<void> {
    const soon = new Date(now.getTime() + REMINDER_BEFORE_MS);
    const due = await this.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, 'active'),
          lte(schedules.nextRunAt, soon),
          gt(schedules.nextRunAt, now),
          eq(schedules.attempts, 0),
          or(isNull(schedules.remindedFor), ne(schedules.remindedFor, schedules.nextRunAt)),
        ),
      )
      .limit(100);
    for (const schedule of due) {
      // A payment approved less than a day ahead was only just agreed, so a reminder would be noise.
      if (schedule.approvedAt && schedule.nextRunAt!.getTime() - schedule.approvedAt.getTime() < REMINDER_BEFORE_MS) continue;
      await this.db.update(schedules).set({ remindedFor: schedule.nextRunAt }).where(eq(schedules.id, schedule.id));
      await this.notifications.notify(schedule.userId, `Reminder: ${labelOf(schedule)} will go out on ${describeMoment(schedule.nextRunAt!)}.`);
    }
  }

  private async run(schedule: Schedule, now: Date): Promise<void> {
    const dueAt = schedule.nextRunAt!;
    const [run] = await this.db.insert(scheduleRuns).values({ scheduleId: schedule.id, dueAt }).onConflictDoNothing().returning();
    if (!run) return this.recover(schedule, dueAt, now);
    await this.finishRun(schedule, run.id, now);
  }

  private async finishRun(schedule: Schedule, runId: string, now: Date): Promise<void> {
    // Anything unexpected before money moved, such as a partner hiccup, counts as a failed try and not a lost payment.
    const attempt = await this.attempt(schedule, runId).catch((error: Error): Attempt => {
      this.logger.error(`Schedule ${schedule.id} attempt failed: ${error.name}`);
      return { ok: false, reason: 'Temporary problem', notify: '' };
    });
    const run = { id: runId };
    if (attempt.ok) {
      await this.db.update(scheduleRuns).set({ status: 'succeeded' }).where(eq(scheduleRuns.id, run.id));
      await this.advance(schedule, now);
      const [done] = await this.db.select().from(payments).where(eq(payments.id, attempt.payment.id));
      if (done?.status === 'completed') await this.notifications.notify(schedule.userId, `Scheduled payment sent, as you approved: ${labelOf(schedule)} (${schedule.recipientDetail}).`);
      else if (done?.status === 'paying') await this.notifications.notify(schedule.userId, `Scheduled payment processing, as you approved: ${labelOf(schedule)} (${schedule.recipientDetail}).`);
      return;
    }
    await this.db.update(scheduleRuns).set({ status: 'failed', error: attempt.reason }).where(eq(scheduleRuns.id, run.id));
    await this.fail(schedule, attempt, now);
  }

  /** The run was already started, so a crash cut it short. Never spend again without knowing what happened. */
  private async recover(schedule: Schedule, dueAt: Date, now: Date): Promise<void> {
    const [row] = await this.db
      .select({ run: scheduleRuns, payment: payments })
      .from(scheduleRuns)
      .leftJoin(payments, eq(payments.scheduleRunId, scheduleRuns.id))
      .where(and(eq(scheduleRuns.scheduleId, schedule.id), eq(scheduleRuns.dueAt, dueAt)));
    if (!row) return;
    // No payment row means no money moved, and the unique run id means repeating this cannot pay twice.
    if (!row.payment) return this.finishRun(schedule, row.run.id, now);
    if (row.payment.status === 'failed') {
      return this.fail(schedule, { ok: false, reason: row.payment.failureReason ?? 'Failed', notify: '' }, now);
    }
    if (row.payment.status === 'funding') {
      await this.db
        .update(payments)
        .set({ status: 'needs_support', failureReason: 'The server stopped during this payment. Check the chain before sending again.' })
        .where(and(eq(payments.id, row.payment.id), eq(payments.status, 'funding')));
      this.logger.error(`Schedule ${schedule.id} needs a person to check payment ${row.payment.id}`);
    }
    await this.advance(schedule, now);
  }

  private async attempt(schedule: Schedule, runId: string): Promise<Attempt> {
    const [owner] = await this.db.select().from(users).where(eq(users.id, schedule.userId));
    if (!owner) return { ok: false, reason: 'No such user', notify: '' };
    const nairaPerUsdc = await this.rates.nairaPerUsdc();
    const usdcMinor = schedule.fixedUsdcMinor ?? koboToUsdcMinor(schedule.amountKobo, nairaPerUsdc);
    const label = labelOf(schedule);
    const paused = await this.guards.refusal([schedule.route], schedule.amountKobo);
    if (paused) return { ok: false, reason: 'Paused or over the company cap', notify: '' };
    const request = { reference: runId, route: schedule.route, destination: schedule.destination, amountKobo: schedule.amountKobo, usdcMinor };

    if (this.onChain) {
      const permission = schedule.permission as SpendPermission | null;
      if (!permission) return { ok: false, reason: 'No permission', notify: `${label} could not go out: the approval is missing.` };
      if (BigInt(usdcMinor) > BigInt(permission.allowance)) {
        return { ok: false, reason: 'Rate past the approved limit', notify: `${label} did not go out: the exchange rate moved past the limit you approved. You can cancel this and set it up again.` };
      }
      if (Date.now() / 1000 > permission.end) return { ok: false, reason: 'Permission ended', notify: `${label} did not go out: your approval has ended. Please set it up again.` };
      // The wallet the permission spends from, which is the one that must hold the money.
      const balance = await this.chain.usdcBalance(permission.account).catch(() => null);
      if (balance === null) return { ok: false, reason: 'Could not read balance', notify: '' };
      if (balance < BigInt(usdcMinor)) {
        return { ok: false, reason: 'Not enough USDC', notify: `${label} did not go out: it needs ${formatUsdc(usdcMinor)} and your wallet has ${formatUsdc(Number(balance))}.` };
      }
    }
    const refusal = await this.provider.refusal(request).catch(() => 'The partner could not be reached.');
    if (refusal) return { ok: false, reason: refusal, notify: `${label} did not go out: ${refusal}` };

    let fundingAddress: string | null = null;
    let refundable = false;
    if (this.onChain) {
      if (schedule.route === 'usdc') fundingAddress = (schedule.destination as { walletAddress: string }).walletAddress;
      else {
        const partner = await this.provider.fundingAddress({ ...request, destination: { ...(schedule.destination as object), refundAddress: owner.walletAddress } }).catch(() => undefined);
        if (partner === undefined) return { ok: false, reason: 'Partner unavailable', notify: `${label} did not go out: the partner could not be reached.` };
        fundingAddress = partner ?? this.config.get('COLLECTION_ADDRESS', { infer: true })!;
        refundable = !partner;
      }
    }

    // The limit and the payment row commit together under the same lock approvals use.
    const payment = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${schedule.userId}, 0))`);
      // Read again under a row lock: the user may have cancelled since this run was claimed.
      const [current] = await tx.select({ status: schedules.status }).from(schedules).where(eq(schedules.id, schedule.id)).for('update');
      if (current?.status !== 'active') return 'cancelled' as const;
      const left = await this.limits.leftTodayKobo(schedule.userId, tx);
      if (schedule.amountKobo > left) return null;
      const [row] = await tx
        .insert(payments)
        .values({
          userId: schedule.userId,
          scheduleRunId: runId,
          route: schedule.route,
          amountKobo: schedule.amountKobo,
          usdcMinor,
          recipientName: schedule.recipientName,
          destination: schedule.destination,
          status: this.onChain ? 'funding' : 'pending',
          fundingAddress,
          refundable,
        })
        .returning();
      return row!;
    });
    if (payment === 'cancelled') return { ok: false, reason: 'Cancelled', notify: '' };
    if (!payment) {
      return { ok: false, reason: 'Over the daily limit', notify: `${label} did not go out: it would pass your ${formatNaira(DAILY_LIMIT_KOBO)} daily limit.` };
    }

    if (!this.onChain) {
      await this.engine.paySimulated(payment);
      const [done] = await this.db.select().from(payments).where(eq(payments.id, payment.id));
      if (done?.status === 'failed') return { ok: false, reason: done.failureReason ?? 'Failed', notify: `${label} did not go out: ${done.failureReason ?? 'the partner refused it'}.` };
      return { ok: true, payment };
    }

    let hash: string;
    try {
      hash = await this.chain.spendAndForward(schedule.permission as SpendPermission, usdcMinor, fundingAddress!, async (sent) => {
        await this.db.update(payments).set({ fundingTxHash: sent }).where(eq(payments.id, payment.id));
      });
    } catch (error) {
      if (error instanceof SpendRefused) {
        this.logger.warn(`Spend refused for schedule ${schedule.id}`);
        await this.db.update(payments).set({ status: 'failed', failureReason: 'The wallet permission refused it.' }).where(eq(payments.id, payment.id));
        return { ok: false, reason: 'Spend refused', notify: `${label} did not go out: the blockchain transaction did not go through.` };
      }
      // It may have gone out, so sending again could pay twice. A person checks the chain instead.
      this.logger.error(`Spend outcome unknown for schedule ${schedule.id}, payment ${payment.id}: ${(error as Error).name}`);
      await this.db
        .update(payments)
        .set({ status: 'needs_support', failureReason: 'We could not confirm this transaction. Check the chain before sending again.' })
        .where(eq(payments.id, payment.id));
      await this.notifications.notify(schedule.userId, `${label}: we could not confirm it went through. Our team is checking, and it will not be sent again until then.`);
      return { ok: true, payment };
    }
    await this.db.update(payments).set({ status: 'funded', fundingTxHash: hash }).where(eq(payments.id, payment.id));
    await this.engine.deliver(payment.id);
    return { ok: true, payment };
  }

  /** Moves on to the next date, or finishes. */
  private async advance(schedule: Schedule, now: Date): Promise<void> {
    const timing = schedule.timing as Timing;
    const runsLeft = schedule.runsLeft === null ? null : schedule.runsLeft - 1;
    const following = runsLeft === 0 ? null : this.nextAfter(timing, schedule.scheduledFor ?? schedule.nextRunAt!, now);
    await this.db
      .update(schedules)
      .set({
        status: following ? 'active' : 'completed',
        scheduledFor: following,
        nextRunAt: following,
        runsLeft,
        attempts: 0,
        lastError: null,
        leaseUntil: null,
      })
      .where(and(eq(schedules.id, schedule.id), eq(schedules.status, 'active')));
  }

  /** After downtime, go to the next date still ahead, rather than paying several missed months at once. */
  private nextAfter(timing: Timing, from: Date, now: Date): Date | null {
    let next = nextRun(timing, from);
    while (next && next <= now) next = nextRun(timing, next);
    return next;
  }

  /** Not sent: tell the user, and try again tomorrow. After three retries, wait for the next date. */
  private async fail(schedule: Schedule, attempt: Extract<Attempt, { ok: false }>, now: Date): Promise<void> {
    if (attempt.reason === 'Cancelled') return;
    const attempts = schedule.attempts + 1;
    const scheduledFor = schedule.scheduledFor ?? schedule.nextRunAt!;
    const timing = schedule.timing as Timing;
    const regular = this.nextAfter(timing, scheduledFor, now);
    const tooMany = attempts > MAX_RETRIES;
    const label = labelOf(schedule);

    if (tooMany) {
      await this.db
        .update(schedules)
        .set(
          regular
            ? { scheduledFor: regular, nextRunAt: regular, attempts: 0, lastError: attempt.reason, leaseUntil: null }
            : { status: 'failed', nextRunAt: null, attempts, lastError: attempt.reason, leaseUntil: null },
        )
        .where(and(eq(schedules.id, schedule.id), eq(schedules.status, 'active')));
      await this.notifications.notify(
        schedule.userId,
        regular ? `I tried ${label} several times and it did not go out. I will try again on ${describeMoment(regular)}.` : `I tried ${label} several times and it did not go out, so I have stopped.`,
      );
      return;
    }
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const retryAt = regular && regular < tomorrow ? regular : tomorrow;
    await this.db
      .update(schedules)
      .set({ nextRunAt: retryAt, attempts, lastError: attempt.reason, leaseUntil: null })
      .where(and(eq(schedules.id, schedule.id), eq(schedules.status, 'active')));
    if (attempt.notify) await this.notifications.notify(schedule.userId, `${attempt.notify} I will try again on ${describeMoment(retryAt)}.`);
  }

  /** Used by tests and the admin panel to see what is open. */
  async openRuns(scheduleIds: string[]) {
    if (scheduleIds.length === 0) return [];
    return this.db.select().from(scheduleRuns).where(inArray(scheduleRuns.scheduleId, scheduleIds));
  }
}
