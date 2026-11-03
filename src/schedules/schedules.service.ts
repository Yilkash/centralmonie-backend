import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { SpendPermission, WalletCall } from '../chain/chain';
import { addManagerOwnerCall, approvePermissionCall, Chain, revokePermissionCall } from '../chain/chain.service';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { Schedule, schedules, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, koboToUsdcMinor } from '../money/money';
import { AuditService } from '../ops/audit.service';
import { GuardsService } from '../ops/guards.service';
import { PlanRefused } from '../plans/plan-refused';
import { ProposedItem } from '../plans/plan.types';
import { PlansService } from '../plans/plans.service';
import { ExchangeRates } from '../providers/providers';
import { describeTiming, firstRun, normalise, permissionPeriodSeconds, Timing, TimingRefused } from './timing';

const PROPOSAL_LIFETIME_MS = 30 * 60 * 1000;
const SIGNATURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ITEMS = 10;
const MAX_ACTIVE = 50;
const PERMISSION_LIFETIME_S = 365 * 86400;

export interface ProposedSchedule extends ProposedItem {
  timing: Timing;
}

export interface ScheduleGroupView {
  groupId: string;
  status: Schedule['status'];
  items: Schedule[];
  calls: WalletCall[];
}

export const whenOf = (schedule: Schedule): string => {
  const timing = schedule.timing as Timing;
  if (schedule.status === 'proposed') return describeTiming(timing, null);
  // Finished or stopped: there is no next date, and "from when you approve" would no longer make sense.
  if (!schedule.nextRunAt && timing.kind === 'once') return 'One time';
  return describeTiming(timing, schedule.nextRunAt);
};

/** Approval and cancellation of payments for later. Running them is the scheduler's job. */
@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly plans: PlansService,
    private readonly chain: Chain,
    private readonly rates: ExchangeRates,
    private readonly config: ConfigService<Env, true>,
    private readonly guards: GuardsService,
    private readonly audit: AuditService,
  ) {}

  private get onChain(): boolean {
    return this.config.get('PAYMENTS_MODE', { infer: true }) === 'chain';
  }

  /** Re-checks everything the agent proposed, the same way as a payment for now. */
  async propose(userId: string, proposed: ProposedSchedule[]): Promise<ScheduleGroupView> {
    if (proposed.length === 0) throw new PlanRefused('A schedule needs at least one payment.');
    if (proposed.length > MAX_ITEMS) throw new PlanRefused(`I can set up at most ${MAX_ITEMS} payments at a time.`);
    const nairaPerUsdc = await this.rates.nairaPerUsdc();
    const now = new Date();
    const groupId = randomUUID();
    const rows = await Promise.all(
      proposed.map(async (item) => {
        const priced = await this.plans.priced(userId, item, nairaPerUsdc);
        if (priced.amountKobo > DAILY_LIMIT_KOBO) {
          throw new PlanRefused(`A single payment cannot be over the ${formatNaira(DAILY_LIMIT_KOBO)} daily limit, because it could never run.`);
        }
        try {
          const timing = normalise(item.timing, now);
          firstRun(timing, now);
          return {
            userId,
            groupId,
            timing,
            route: priced.route,
            recipientName: priced.recipientName,
            recipientDetail: priced.recipientDetail,
            destination: priced.destination,
            dataPlan: priced.dataPlan,
            amountKobo: priced.amountKobo,
            fixedUsdcMinor: item.route === 'usdc' || (item.route === 'bank' && item.amountNaira === null) ? priced.usdcMinor : null,
            runsLeft: timing.kind === 'once' ? 1 : timing.occurrences,
            expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS),
          };
        } catch (error) {
          if (error instanceof TimingRefused) throw new PlanRefused(error.message);
          throw error;
        }
      }),
    );
    const refused = await this.guards.refusal(rows.map((row) => row.route), 0);
    if (refused) throw new PlanRefused(refused);
    await this.db.insert(schedules).values(rows);
    await this.audit.record('agent', 'schedule.proposed', groupId, { userId, items: rows.map((row) => ({ route: row.route, to: row.recipientName, kobo: row.amountKobo, timing: row.timing })) });
    return this.group(userId, groupId);
  }

  async group(userId: string, groupId: string): Promise<ScheduleGroupView> {
    const items = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.groupId, groupId), eq(schedules.userId, userId)))
      .orderBy(asc(schedules.createdAt), asc(schedules.id));
    if (items.length === 0) throw new NotFoundException('Schedule not found');
    return { groupId, items, status: items[0]!.status, calls: await this.signatureCalls(items) };
  }

  private async signatureCalls(items: Schedule[]): Promise<WalletCall[]> {
    const waiting = items.filter((item) => item.status === 'awaiting_signature' && item.permission);
    if (waiting.length === 0) return [];
    const wallet = (waiting[0]!.permission as SpendPermission).account;
    const setup = (await this.chain.managerIsOwner(wallet)) ? [] : [addManagerOwnerCall(wallet)];
    return [...setup, ...waiting.map((item) => approvePermissionCall(item.permission as SpendPermission))];
  }

  async list(userId: string): Promise<Schedule[]> {
    return this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.userId, userId), inArray(schedules.status, ['active', 'awaiting_signature'])))
      .orderBy(asc(schedules.nextRunAt))
      .limit(100);
  }

  async history(userId: string): Promise<Schedule[]> {
    return this.db.select().from(schedules).where(eq(schedules.userId, userId)).orderBy(desc(schedules.createdAt)).limit(50);
  }

  /** In chain mode this writes the permissions for the wallet to sign. Otherwise it goes live at once. */
  async approve(user: User, groupId: string): Promise<ScheduleGroupView> {
    const { items } = await this.group(user.id, groupId);
    if (items.some((item) => item.status !== 'proposed')) throw new ConflictException('This has already been decided.');
    const now = new Date();
    if (items.some((item) => item.expiresAt <= now)) {
      await this.setGroup(user.id, groupId, { status: 'expired' });
      throw new PlanRefused('This has expired. Nothing was set up. Please ask again.');
    }
    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schedules)
      .where(and(eq(schedules.userId, user.id), eq(schedules.status, 'active')));
    if (count + items.length > MAX_ACTIVE) throw new PlanRefused(`You can have at most ${MAX_ACTIVE} scheduled payments.`);

    const spender = this.onChain ? await this.chain.spender() : null;
    if (this.onChain) {
      if (!user.walletAddress) throw new PlanRefused('Your wallet is still being set up. Please try again in a moment.');
      if (!spender) throw new PlanRefused('Scheduled payments are not available right now. Nothing was set up.');
    }
    const nairaPerUsdc = await this.rates.nairaPerUsdc();
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        const timing = item.timing as Timing;
        let runAt: Date;
        try {
          // Counted now, so "in 30 minutes" means 30 minutes after the user said yes.
          runAt = firstRun(timing, now);
        } catch (error) {
          if (error instanceof TimingRefused) throw new PlanRefused(error.message);
          throw error;
        }
        const claimed = await tx
          .update(schedules)
          .set({
            status: this.onChain ? 'awaiting_signature' : 'active',
            scheduledFor: runAt,
            nextRunAt: runAt,
            approvedAt: now,
            permission: this.onChain ? this.permissionFor(user.walletAddress!, spender!, item, timing, runAt, now, nairaPerUsdc) : null,
          })
          // Only from proposed, so a slow approve cannot undo a reject or replace a signed permission.
          .where(and(eq(schedules.id, item.id), eq(schedules.status, 'proposed')))
          .returning({ id: schedules.id });
        if (claimed.length === 0) throw new ConflictException('This has already been decided.');
      }
    });
    await this.audit.record(user.id, 'schedule.approved', groupId);
    return this.group(user.id, groupId);
  }

  /** Exact for USDC; about 10% above today's price for naira, so a small rate move does not stop the payment. */
  private permissionFor(account: string, spender: string, item: Schedule, timing: Timing, runAt: Date, now: Date, nairaPerUsdc: number): SpendPermission {
    const usdc = item.fixedUsdcMinor ?? Math.ceil((koboToUsdcMinor(item.amountKobo, nairaPerUsdc) * 110) / 100);
    const start = Math.floor(now.getTime() / 1000);
    const period = permissionPeriodSeconds(timing, runAt, now);
    return {
      account,
      spender,
      token: this.chain.usdcAddress(),
      allowance: String(usdc),
      period,
      start,
      // No longer than it needs: limited runs end with their last payment, plus a week for retries.
      end:
        timing.kind === 'once'
          ? start + period
          : start + Math.min(PERMISSION_LIFETIME_S, timing.occurrences ? period * timing.occurrences + 7 * 86400 : PERMISSION_LIFETIME_S),
      salt: BigInt(`0x${randomBytes(16).toString('hex')}`).toString(),
      extraData: '0x',
    };
  }

  /** The wallet sent the permissions. The contract's own record decides whether they took effect. */
  async activate(userId: string, groupId: string, txHash?: string): Promise<ScheduleGroupView> {
    const { items } = await this.group(userId, groupId);
    const waiting = items.filter((item) => item.status === 'awaiting_signature');
    if (waiting.length === 0) return this.group(userId, groupId);
    if (txHash && (await this.chain.outcome(txHash)).state === 'reverted') {
      throw new PlanRefused('The transaction failed, so nothing was set up.');
    }
    const active = await Promise.all(waiting.map((item) => this.chain.permissionActive(item.permission as SpendPermission)));
    if (active.some((value) => !value)) throw new PlanRefused('The permission is not on the chain yet. Please try again in a moment.');
    await this.db
      .update(schedules)
      .set({ status: 'active' })
      .where(inArray(schedules.id, waiting.map((item) => item.id)));
    return this.group(userId, groupId);
  }

  async abandon(userId: string, groupId: string): Promise<ScheduleGroupView> {
    await this.db
      .update(schedules)
      .set({ status: 'expired' })
      .where(and(eq(schedules.groupId, groupId), eq(schedules.userId, userId), eq(schedules.status, 'awaiting_signature')));
    return this.group(userId, groupId);
  }

  async reject(userId: string, groupId: string): Promise<ScheduleGroupView> {
    await this.group(userId, groupId);
    const updated = await this.db
      .update(schedules)
      .set({ status: 'rejected' })
      .where(and(eq(schedules.groupId, groupId), eq(schedules.userId, userId), eq(schedules.status, 'proposed')))
      .returning({ id: schedules.id });
    if (updated.length === 0) throw new ConflictException('This has already been decided.');
    return this.group(userId, groupId);
  }

  private async setGroup(userId: string, groupId: string, values: Partial<Schedule>): Promise<void> {
    await this.db.update(schedules).set(values).where(and(eq(schedules.groupId, groupId), eq(schedules.userId, userId)));
  }

  /**
   * Stops it at once in our own records, whatever happens next. The returned call also removes
   * the permission from the wallet, so the contract refuses it even if our server misbehaved.
   */
  async cancel(userId: string, scheduleId: string): Promise<{ schedule: Schedule; calls: WalletCall[] }> {
    const [schedule] = await this.db
      .update(schedules)
      .set({ status: 'cancelled', cancelledAt: new Date(), nextRunAt: null })
      .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId), inArray(schedules.status, ['active', 'awaiting_signature'])))
      .returning();
    if (!schedule) {
      const [existing] = await this.db.select().from(schedules).where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)));
      if (!existing) throw new NotFoundException('Schedule not found');
      // Finished or expired, the payments have stopped, but the wallet may still hold the permission.
      return { schedule: existing, calls: this.revokeCalls(existing) };
    }
    await this.audit.record(userId, 'schedule.cancelled', scheduleId);
    return { schedule, calls: this.revokeCalls(schedule) };
  }

  private revokeCalls(schedule: Schedule): WalletCall[] {
    return schedule.permission ? [revokePermissionCall(schedule.permission as SpendPermission)] : [];
  }

  async get(userId: string, scheduleId: string): Promise<Schedule | null> {
    const [schedule] = await this.db.select().from(schedules).where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)));
    return schedule ?? null;
  }

  /** Clears what was never signed, first checking the chain in case the browser closed after sending. */
  async reconcile(): Promise<void> {
    const cutoff = new Date(Date.now() - SIGNATURE_WINDOW_MS);
    const late = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.status, 'awaiting_signature'), lt(schedules.approvedAt, cutoff)))
      .limit(100);
    for (const item of late) {
      try {
        const active = await this.chain.permissionActive(item.permission as SpendPermission);
        await this.db.update(schedules).set({ status: active ? 'active' : 'expired' }).where(eq(schedules.id, item.id));
      } catch (error) {
        this.logger.error(`Could not check permission for ${item.id}: ${(error as Error).name}`);
      }
    }
    await this.db
      .update(schedules)
      .set({ status: 'expired' })
      .where(and(eq(schedules.status, 'proposed'), lte(schedules.expiresAt, new Date())));
  }

  /** Claims due schedules with a lease, so a second server, or a crash, cannot run one at the same moment. */
  async claimDue(now: Date, leaseMs: number, limit = 50): Promise<Schedule[]> {
    const due = await this.db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.status, 'active'), lte(schedules.nextRunAt, now), or(isNull(schedules.leaseUntil), lt(schedules.leaseUntil, now))))
      .orderBy(asc(schedules.nextRunAt))
      .limit(limit);
    const claimed: Schedule[] = [];
    for (const { id } of due) {
      const [row] = await this.db
        .update(schedules)
        .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
        .where(and(eq(schedules.id, id), eq(schedules.status, 'active'), or(isNull(schedules.leaseUntil), lt(schedules.leaseUntil, now))))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }
}
