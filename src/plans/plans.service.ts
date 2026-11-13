import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { WalletCall } from '../chain/chain';
import { CrossChain, routeProblem } from '../agent-api/cross-chain';
import { addressRefusal, checkAddress } from '../chain/address-check';
import { chainOfWallet } from '../chain/usdc-chains';
import { Chain, usdcTransferCall } from '../chain/chain.service';
import { Env } from '../config/env';
import { describeDestination, ContactsService } from '../contacts/contacts.service';
import { DATABASE, Database } from '../database/database.module';
import { LimitsService } from '../payments/limits.service';
import { PaymentEngine } from '../payments/payment-engine.service';
import { AuditService } from '../ops/audit.service';
import { GuardsService } from '../ops/guards.service';
import { SwitchesService } from '../ops/switches.service';
import { contacts, Plan, PlanItem, Payment, payments, planItems, plans, User, users, ProtectCheck } from '../database/schema';
import { ProtectService } from '../protect/protect.service';
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
  /** The network USDC moves on. */
  network: string;
  totalKobo: number;
  totalUsdcMinor: number;
  /** What the wallet must send when payments are waiting for the user's signature. */
  calls: WalletCall[];
  /** CentralMonie Protect's newest check of this plan, when Protect is on. */
  protect: ProtectCheck | null;
}

const CROSS_CHAIN_ROUTE_MS = 30 * 60_000;

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
    private readonly crossChain: CrossChain,
    private readonly switches: SwitchesService,
    private readonly config: ConfigService<Env, true>,
    private readonly guards: GuardsService,
    private readonly audit: AuditService,
    private readonly protect: ProtectService,
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
    const refused = await this.guards.refusal(rows.map((row) => row.route), total);
    if (refused) throw new PlanRefused(refused);

    const plan = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(plans)
        .values({ userId, quoteExpiresAt: new Date(Date.now() + QUOTE_LIFETIME_MS) })
        .returning();
      await tx.insert(planItems).values(rows.map((row) => ({ ...row, planId: created!.id })));
      return created!;
    });
    await this.audit.record('agent', 'plan.proposed', plan.id, { userId, items: rows.map((row) => ({ route: row.route, to: row.recipientName, kobo: row.amountKobo })) });
    return this.get(userId, plan.id);
  }

  async priced(userId: string, item: ProposedItem, nairaPerUsdc: number) {
    const usable =
      item.newRecipient && item.route !== 'data'
        ? await this.contacts.newDestination(userId, item.destinationId, ({ airtime: 'phone', usdc: 'wallet', bank: 'bank' } as const)[item.route])
        : await this.contacts.usableDestination(userId, item.destinationId);
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

    // A USDC amount to a bank account is exactly that much USDC, paid out as naira at the rate.
    if (item.route === 'usdc' || (item.route === 'bank' && item.amountNaira === null && item.amountUsdc !== null)) {
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

    const minimum = this.provider.minimumUsdcMinor(item.route);
    if (usdcMinor < minimum) {
      // Said before the card appears, with the naira figure, so nobody approves a payment that cannot go.
      const smallest = formatNaira(Math.ceil(usdcMinorToKobo(minimum, nairaPerUsdc) / 100) * 100);
      throw new PlanRefused(`The smallest bank transfer is ${formatUsdc(minimum)}, about ${smallest}.`);
    }

    // Crypto sent to a wrong address cannot come back, so these are stopped and the whole address is always shown.
    let addressCheck: string | null = null;
    let delivery: PlanItem['delivery'] = null;
    if (item.route === 'usdc' && destination.walletAddress) {
      const [owner] = await this.db.select({ wallet: users.walletAddress }).from(users).where(eq(users.id, userId));
      const refused = addressRefusal(destination.walletAddress, { usdc: this.chain.usdcAddress(), own: owner?.wallet ?? null });
      if (refused) throw new PlanRefused(refused);
      const chain = chainOfWallet(destination);
      if (chain.key === 'base') {
        if (this.onChain) addressCheck = await checkAddress(this.chain, destination.walletAddress);
      } else {
        if (await this.switches.isPaused('usdc_other_chains')) throw new PlanRefused(`Sending to ${chain.name} is paused for the moment. Nothing was sent.`);
        const unready = await this.crossChain.recipientProblem(chain.key, destination.walletAddress);
        if (unready) throw new PlanRefused(unready);
        const priced = await this.crossChain
          .sendFromBase({ usdcMinor, destinationAsset: chain.assetId, destinationDecimals: chain.decimals, recipient: destination.walletAddress, refundTo: owner?.wallet ?? this.chain.usdcAddress(), deadline: new Date(Date.now() + CROSS_CHAIN_ROUTE_MS), dry: true })
          .catch((error: unknown) => {
            throw new PlanRefused(routeProblem(error, chain.name));
          });
        delivery = { chain: chain.key, name: chain.name, receiverMinor: priced.receiverMinor, seconds: priced.seconds, token: chain.token, caution: chain.caution ?? null };
      }
    }

    return {
      route: item.route,
      recipientName: contact.name,
      recipientDetail: destination.walletAddress ?? describeDestination(destination),
      addressCheck,
      delivery,
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
      network: this.chain.networkName(),
      calls: items.flatMap(({ payment }) =>
        payment?.status === 'awaiting_signature' ? [usdcTransferCall(this.chain.usdcAddress(), payment.fundingAddress!, payment.usdcMinor)] : [],
      ),
      totalKobo: items.reduce((sum, item) => sum + item.amountKobo, 0),
      totalUsdcMinor: items.reduce((sum, item) => sum + item.usdcMinor, 0),
      protect: this.protect.enabled ? await this.protect.latest('plan', planId) : null,
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
      const total = items.reduce((sum, item) => sum + item.amountKobo, 0);
      await this.assertWithinDailyLimit(tx, userId, total);
      const refused = await this.guards.refusal(items.map((item) => item.route), total, tx);
      if (refused) throw new PlanRefused(refused);
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
      // Approving a payment to a new number also saves that number, so one tap does both.
      const contactIds = [...new Set(items.map((item) => (item.destination as { contactId?: string }).contactId).filter((id): id is string => Boolean(id)))];
      if (contactIds.length > 0) {
        await tx.update(contacts).set({ status: 'confirmed' }).where(and(inArray(contacts.id, contactIds), eq(contacts.userId, userId), eq(contacts.status, 'proposed')));
      }
      return { rows, items };
    });
    if (!created) throw new PlanRefused('This quote has expired. Please ask again for a new one.');

    await this.audit.record(userId, 'plan.approved', planId);
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
        const to = (item.destination as { walletAddress: string }).walletAddress;
        const chain = chainOfWallet(item.destination as { walletAddress: string; network?: string | null });
        if (chain.key === 'base') {
          addresses.set(item.id, { address: to, refundable: false });
          continue;
        }
        // The user pays on Base. NEAR Intents delivers on the other chain, and refunds this wallet if it cannot.
        if (await this.switches.isPaused('usdc_other_chains')) throw new PlanRefused(`Sending to ${chain.name} is paused for the moment. Nothing was sent.`);
        const route = await this.crossChain
          .sendFromBase({ usdcMinor: item.usdcMinor, destinationAsset: chain.assetId, destinationDecimals: chain.decimals, recipient: to, refundTo: user.walletAddress, deadline: new Date(Date.now() + CROSS_CHAIN_ROUTE_MS), dry: false })
          .catch((error: unknown) => {
            throw new PlanRefused(routeProblem(error, chain.name));
          });
        addresses.set(item.id, { address: route.depositAddress!, refundable: false });
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
