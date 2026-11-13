import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { FundingService } from '../payments/funding.service';
import { PinService } from '../pin/pin.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { ChainKey, USDC_CHAINS } from '../chain/usdc-chains';
import { formatNaira, formatUsdc } from '../money/money';
import { PlanRefused, PlansService, PlanView } from './plans.service';
import { presentCheck, ProtectService } from '../protect/protect.service';

/** An amount in USDC's six decimals, named as the token the receiver really gets. */
const inToken = (minor: number, token?: 'USDC' | 'USDT') => formatUsdc(minor).replace('USDC', token ?? 'USDC');

export const pinIn = (body: unknown): string | undefined => {
  const pin = (body as { pin?: unknown } | null | undefined)?.pin;
  return typeof pin === 'string' ? pin : undefined;
};

const fundingBody = z.object({ tx_hash: z.string() });

export const presentPlan = (plan: PlanView) => ({
  id: plan.id,
  protect: presentCheck(plan.protect),
  status: plan.status,
  quote_expires_at: plan.quoteExpiresAt,
  total_naira: formatNaira(plan.totalKobo),
  total_usdc: formatUsdc(plan.totalUsdcMinor),
  calls: plan.calls,
  items: plan.items.map((item) => ({
    id: item.id,
    route: item.route,
    recipient_name: item.recipientName,
    recipient_detail: item.recipientDetail,
    network: item.route !== 'usdc' ? null : (item.delivery?.name ?? plan.network),
    receiver_gets: item.delivery ? inToken(item.delivery.receiverMinor, item.delivery.token) : null,
    receiver_token: item.delivery?.token ?? (item.route === 'usdc' ? 'USDC' : null),
    delivery_caution: item.delivery?.caution ?? null,
    receiver_gets_exact: item.delivery ? (item.delivery.receiverMinor / 1_000_000).toFixed(6) : null,
    delivery_seconds: item.delivery?.seconds ?? null,
    received: item.payment?.deliveredMinor ? inToken(item.payment.deliveredMinor, item.delivery?.token) : null,
    delivery_tx_url: item.delivery && item.payment?.status === 'completed' && item.payment.providerReference ? `${USDC_CHAINS[item.delivery.chain as ChainKey]?.explorerTx ?? ''}${item.payment.providerReference}` : null,
    fee_warning: item.delivery ? item.usdcMinor - item.delivery.receiverMinor > item.usdcMinor * 0.02 : false,
    address_check: item.addressCheck,
    data_plan: item.dataPlan,
    amount_naira: formatNaira(item.amountKobo),
    amount_usdc: formatUsdc(item.usdcMinor),
    payment_id: item.payment?.id ?? null,
    payment_status: item.payment?.status ?? null,
    failure_reason: item.payment?.failureReason ?? null,
    tx_hash: item.payment?.fundingTxHash ?? null,
    paid_at: item.payment?.createdAt ?? null,
    refund_tx_hash: item.payment?.refundTxHash ?? null,
    simulated: !item.payment || (item.payment.providerReference?.startsWith('simulated-') ?? false),
  })),
});

@Controller('v1/plans')
@UseGuards(AuthGuard)
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly funding_: FundingService,
    private readonly pins: PinService,
    private readonly protect: ProtectService,
  ) {}

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentPlan(await this.plans.get(user.id, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.pins.check(user, pinIn(body));
    await this.enforceProtect(user, id, body);
    try {
      return presentPlan(await this.plans.approve(user, id));
    } catch (error) {
      if (error instanceof PlanRefused) throw new UnprocessableEntityException(error.message);
      throw error;
    }
  }

  /**
   * 10kobo Protect, when on: a payment SERV blocked cannot be approved, and one it flagged needs the owner to confirm
   * they checked it ("protect_confirmed": true). The plan must belong to the user, which get() checks.
   */
  private async enforceProtect(user: User, id: string, body: unknown) {
    if (!this.protect.enabled) return;
    await this.plans.get(user.id, id);
    const check = await this.protect.latest('plan', id);
    if (!check) return;
    if (check.verdict === 'block') throw new UnprocessableEntityException(`10kobo Protect blocked this payment. ${check.summary ?? ''}`.trim());
    if (check.verdict === 'ask' && !check.acknowledgedAt) {
      if ((body as { protect_confirmed?: unknown } | null)?.protect_confirmed !== true) {
        throw new UnprocessableEntityException('10kobo Protect asks you to confirm this payment first. Check the warning, then confirm.');
      }
      await this.protect.acknowledge('plan', id);
    }
  }

  /** The wallet has sent the transaction. The chain is checked before anything is delivered. */
  @Post(':id/funding')
  @HttpCode(200)
  async funding(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = fundingBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A transaction hash is required');
    try {
      await this.funding_.confirm(user.id, id, parsed.data.tx_hash);
    } catch (error) {
      if (error instanceof PlanRefused) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    return presentPlan(await this.plans.get(user.id, id));
  }

  /** Before signing again: finds a transaction that already went out, so the user cannot pay twice. */
  @Post(':id/recheck')
  @HttpCode(200)
  async recheck(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.funding_.recheck(user.id, id);
    return presentPlan(await this.plans.get(user.id, id));
  }

  /** The user closed the wallet prompt without signing. */
  @Post(':id/abandon')
  @HttpCode(200)
  async abandon(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.funding_.abandon(user.id, id);
    return presentPlan(await this.plans.get(user.id, id));
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentPlan(await this.plans.reject(user.id, id));
  }
}
