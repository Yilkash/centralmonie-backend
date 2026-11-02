import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { describeDestination, ContactsService } from '../contacts/contacts.service';
import { DATABASE, Database } from '../database/database.module';
import { Plan, PlanItem, Payment, payments, planItems, plans } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, koboToUsdcMinor, nairaToKobo, parseUsdc, usdcMinorToKobo } from '../money/money';
import { DataPlans, ExchangeRates, PaymentProvider } from '../providers/providers';
import { ProposedItem } from './plan.types';

const QUOTE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ITEMS = 10;
const AIRTIME_MIN_NAIRA = 50;

/** A plan that cannot go ahead. The message is safe to show the user or give to the agent. */
export class PlanRefused extends Error {}

export interface PlanView extends Plan {
  items: (PlanItem & { payment: Payment | null })[];
  totalKobo: number;
  totalUsdcMinor: number;
}

// The start of today in Nigeria, whatever time zone the server runs in.
const startOfLagosDay = sql`(date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`;

@Injectable()
export class PlansService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly rates: ExchangeRates,
    private readonly dataPlans: DataPlans,
    private readonly provider: PaymentProvider,
  ) {}

  /** Re-checks everything the agent proposed. Nothing the agent says is taken on trust. */
  async propose(userId: string, proposed: ProposedItem[]): Promise<PlanView> {
    if (proposed.length === 0) throw new PlanRefused('A plan needs at least one payment.');
    if (proposed.length > MAX_ITEMS) throw new PlanRefused(`A plan can have at most ${MAX_ITEMS} payments.`);

    const nairaPerUsdc = await this.rates.nairaPerUsdc();
    const rows = await Promise.all(
      proposed.map(async (item, position) => ({ position, ...(await this.priced(userId, item, nairaPerUsdc)) })),
    );

    const total = rows.reduce((sum, row) => sum + row.amountKobo, 0);
    await this.assertWithinDailyLimit(this.db, userId, total);

    const plan = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(plans)
        .values({ userId, quoteExpiresAt: new Date(Date.now() + QUOTE_LIFETIME_MS) })
        .returning();
      await tx.insert(planItems).values(rows.map((row) => ({ ...row, planId: created!.id })));
      return created!;
    });
    return this.get(userId, plan.id);
  }

  private async priced(userId: string, item: ProposedItem, nairaPerUsdc: number) {
    const usable = await this.contacts.usableDestination(userId, item.destinationId);
    if (!usable) throw new PlanRefused('That recipient is not one of the saved contacts.');
    const { contact, destination } = usable;

    const required = { airtime: 'phone', data: 'phone', bank: 'bank', usdc: 'wallet' } as const;
    if (destination.kind !== required[item.route]) {
      throw new PlanRefused(`${contact.name} has no ${required[item.route]} saved for this payment.`);
    }

    let amountKobo: number;
    let usdcMinor: number;
    let dataPlan: string | null = null;

    if (item.route === 'usdc') {
      const parsed = item.amountUsdc === null ? null : parseUsdc(item.amountUsdc);
      if (!parsed) throw new PlanRefused('A USDC payment needs a positive USDC amount.');
      usdcMinor = parsed;
      amountKobo = usdcMinorToKobo(parsed, nairaPerUsdc);
    } else {
      if (item.route === 'data') {
        const plan = item.dataPlanId ? await this.dataPlans.find(item.dataPlanId) : null;
        if (!plan || plan.network !== destination.network) {
          throw new PlanRefused(`That data plan is not available on ${destination.network}.`);
        }
        amountKobo = plan.priceKobo;
        dataPlan = plan.label;
      } else {
        if (!Number.isInteger(item.amountNaira) || item.amountNaira! <= 0) {
          throw new PlanRefused('A naira payment needs a positive whole naira amount.');
        }
        if (item.route === 'airtime' && item.amountNaira! < AIRTIME_MIN_NAIRA) {
          throw new PlanRefused(`The smallest airtime purchase is ₦${AIRTIME_MIN_NAIRA}.`);
        }
        amountKobo = nairaToKobo(item.amountNaira!);
      }
      usdcMinor = koboToUsdcMinor(amountKobo, nairaPerUsdc);
    }

    return {
      route: item.route,
      recipientName: contact.name,
      recipientDetail: describeDestination(destination),
      destination,
      dataPlan,
      amountKobo,
      usdcMinor,
    };
  }

  private async assertWithinDailyLimit(db: Pick<Database, 'select'>, userId: string, addedKobo: number): Promise<void> {
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${payments.amountKobo}), 0)` })
      .from(payments)
      .where(and(eq(payments.userId, userId), ne(payments.status, 'failed'), sql`${payments.createdAt} >= ${startOfLagosDay}`));
    const used = Number(row!.used);
    if (used + addedKobo > DAILY_LIMIT_KOBO) {
      throw new PlanRefused(
        `This would go over the ${formatNaira(DAILY_LIMIT_KOBO)} daily limit. ${formatNaira(Math.max(DAILY_LIMIT_KOBO - used, 0))} is left today.`,
      );
    }
  }

  async get(userId: string, planId: string): Promise<PlanView> {
    const [plan] = await this.db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
    if (!plan) throw new NotFoundException('Plan not found');
    const rows = await this.db
      .select({ item: planItems, payment: payments })
      .from(planItems)
      .leftJoin(payments, eq(payments.planItemId, planItems.id))
      .where(eq(planItems.planId, planId))
      .orderBy(asc(planItems.position));
    const items = rows.map((row) => ({ ...row.item, payment: row.payment }));
    return {
      ...plan,
      items,
      totalKobo: items.reduce((sum, item) => sum + item.amountKobo, 0),
      totalUsdcMinor: items.reduce((sum, item) => sum + item.usdcMinor, 0),
    };
  }

  async reject(userId: string, planId: string): Promise<PlanView> {
    const updated = await this.db
      .update(plans)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(and(eq(plans.id, planId), eq(plans.userId, userId), eq(plans.status, 'proposed')))
      .returning({ id: plans.id });
    if (updated.length === 0) await this.refuseDecision(userId, planId);
    return this.get(userId, planId);
  }

  /**
   * The only way money moves. Approval, the limit check and the payment rows commit
   * together under a per-user lock, so concurrent approvals cannot pass the limit or pay twice.
   */
  async approve(userId: string, planId: string): Promise<PlanView> {
    const created = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const [plan] = await tx.select().from(plans).where(and(eq(plans.id, planId), eq(plans.userId, userId)));
      if (!plan) throw new NotFoundException('Plan not found');
      if (plan.status !== 'proposed') throw new ConflictException('This plan has already been decided.');
      if (plan.quoteExpiresAt.getTime() <= Date.now()) {
        await tx.update(plans).set({ status: 'expired', decidedAt: new Date() }).where(eq(plans.id, planId));
        return null;
      }
      const items = await tx.select().from(planItems).where(eq(planItems.planId, planId)).orderBy(asc(planItems.position));
      await this.assertWithinDailyLimit(tx, userId, items.reduce((sum, item) => sum + item.amountKobo, 0));
      const rows = await tx
        .insert(payments)
        .values(items.map((item) => ({ userId, planItemId: item.id, route: item.route, amountKobo: item.amountKobo, usdcMinor: item.usdcMinor })))
        .returning();
      await tx.update(plans).set({ status: 'approved', decidedAt: new Date() }).where(eq(plans.id, planId));
      return { rows, items };
    });
    if (!created) throw new PlanRefused('This quote has expired. Please ask again for a new one.');

    for (const payment of created.rows) {
      const item = created.items.find((candidate) => candidate.id === payment.planItemId)!;
      const result = await this.provider
        .pay({ reference: payment.id, route: payment.route, destination: item.destination, amountKobo: payment.amountKobo, usdcMinor: payment.usdcMinor })
        .catch((error: Error) => ({ ok: false as const, reason: error.message }));
      await this.db
        .update(payments)
        .set(result.ok ? { status: 'completed', providerReference: result.providerReference } : { status: 'failed', failureReason: result.reason })
        .where(eq(payments.id, payment.id));
    }
    return this.get(userId, planId);
  }

  private async refuseDecision(userId: string, planId: string): Promise<never> {
    await this.get(userId, planId);
    throw new ConflictException('This plan has already been decided.');
  }
}
