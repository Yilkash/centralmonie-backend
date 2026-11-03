import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, sql } from 'drizzle-orm';
import { WalletCall } from '../chain/chain';
import { Chain, usdcTransferCall } from '../chain/chain.service';
import { Env } from '../config/env';
import { describeDestination, ContactsService } from '../contacts/contacts.service';
import { DATABASE, Database } from '../database/database.module';
import { LimitsService } from '../payments/limits.service';
import { PaymentEngine } from '../payments/payment-engine.service';
import { Plan, PlanItem, Payment, payments, planItems, plans, User } from '../database/schema';
import { DAILY_LIMIT_KOBO, formatNaira, formatUsdc, koboToUsdcMinor, nairaToKobo, parseUsdc, usdcMinorToKobo } from '../money/money';
import { DataPlans, ExchangeRates, PaymentProvider, PaymentRequest } from '../providers/providers';
import { PlanRefused } from './plan-refused';
import { ProposedItem } from './plan.types';

export { PlanRefused };

const QUOTE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ITEMS = 10;
const AIRTIME_MIN_NAIRA = 50;

export interface PlanView extends Plan {
  items: (PlanItem & { payment: Payment | null })[];
  totalKobo: number;
  totalUsdcMinor: number;
  /** What the wallet must send when payments are waiting for the user's signature. */
  calls: WalletCall[];
}

@Injectable()
export class PlansService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly rates: ExchangeRates,
    private readonly dataPlans: DataPlans,
    private readonly provider: PaymentProvider,
    private readonly limits: LimitsService,
    private readonly engine: PaymentEngine,
    private readonly chain: Chain,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get onChain(): boolean {
    return this.config.get('PAYMENTS_MODE', { infer: true }) === 'chain';
  }

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

  async priced(userId: string, item: ProposedItem, nairaPerUsdc: number) {
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
    let dataPlanId: string | null = null;

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
        dataPlanId = plan.id;
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
      // The partner needs the plan's own id to deliver it.
      destination: dataPlanId ? { ...destination, dataPlanId } : destination,
      dataPlan,
      amountKobo,
      usdcMinor,
    };
  }

  private async assertWithinDailyLimit(db: Pick<Database, 'select'>, userId: string, addedKobo: number): Promise<void> {
    const used = await this.limits.usedTodayKobo(userId, db);
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
      calls: items.flatMap(({ payment }) =>
        payment?.status === 'awaiting_signature' ? [usdcTransferCall(this.chain.usdcAddress(), payment.fundingAddress!, payment.usdcMinor)] : [],
      ),
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
  async approve(user: User, planId: string): Promise<PlanView> {
    const userId = user.id;
    // Partner calls happen outside the lock, and only for a plan that can still be approved.
    const preparation = this.onChain ? await this.prepareFunding(user, planId) : null;
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
        .values(
          items.map((item) => ({
            userId,
            planItemId: item.id,
            route: item.route,
            amountKobo: item.amountKobo,
            usdcMinor: item.usdcMinor,
            recipientName: item.recipientName,
            destination: item.destination,
            ...(preparation
              ? {
                  status: 'awaiting_signature' as const,
                  fundingAddress: preparation.addresses.get(item.id)!.address,
                  refundable: preparation.addresses.get(item.id)!.refundable,
                  fundingFromBlock: preparation.block,
                }
              : {}),
          })),
        )
        .returning();
      await tx.update(plans).set({ status: 'approved', decidedAt: new Date() }).where(eq(plans.id, planId));
      return { rows, items };
    });
    if (!created) throw new PlanRefused('This quote has expired. Please ask again for a new one.');

    if (!preparation) for (const payment of created.rows) await this.engine.paySimulated(payment);
    return this.get(userId, planId);
  }

  /** Before anything is recorded: is there enough USDC and can partners take it, and where must the USDC go? */
  private async prepareFunding(user: User, planId: string) {
    const plan = await this.get(user.id, planId);
    if (plan.status !== 'proposed') throw new ConflictException('This plan has already been decided.');
    if (!user.walletAddress) throw new PlanRefused('Your wallet is still being set up. Please try again in a moment.');
    const balance = await this.chain.usdcBalance(user.walletAddress);
    if (balance < BigInt(plan.totalUsdcMinor)) {
      throw new PlanRefused(`You need ${formatUsdc(plan.totalUsdcMinor)} but your wallet has ${formatUsdc(Number(balance))}. Nothing was sent.`);
    }
    const collection = this.config.get('COLLECTION_ADDRESS', { infer: true })!;
    const addresses = new Map<string, { address: string; refundable: boolean }>();
    for (const item of plan.items) {
      if (item.route === 'usdc') {
        addresses.set(item.id, { address: (item.destination as { walletAddress: string }).walletAddress, refundable: false });
        continue;
      }
      const request: PaymentRequest = {
        reference: item.id,
        route: item.route,
        // A deposit that reaches the partner too late is returned to the user's own wallet.
        destination: { ...(item.destination as object), refundAddress: user.walletAddress },
        amountKobo: item.amountKobo,
        usdcMinor: item.usdcMinor,
      };
      const refusal = await this.provider.refusal(request).catch(() => 'This payment is not available right now. Please try again shortly.');
      if (refusal) throw new PlanRefused(refusal);
      const partner = await this.provider.fundingAddress(request).catch(() => {
        throw new PlanRefused('This payment is not available right now. Nothing was sent. Please try again shortly.');
      });
      addresses.set(item.id, partner ? { address: partner, refundable: false } : { address: collection, refundable: true });
    }
    return { addresses, block: await this.chain.latestBlock() };
  }

  private async refuseDecision(userId: string, planId: string): Promise<never> {
    await this.get(userId, planId);
    throw new ConflictException('This plan has already been decided.');
  }
}
