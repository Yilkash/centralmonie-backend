import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { FundingService } from '../payments/funding.service';
import { PinService } from '../pin/pin.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { PlanRefused, PlansService, PlanView } from './plans.service';

export const pinIn = (body: unknown): string | undefined => {
  const pin = (body as { pin?: unknown } | null | undefined)?.pin;
  return typeof pin === 'string' ? pin : undefined;
};

const fundingBody = z.object({ tx_hash: z.string() });

export const presentPlan = (plan: PlanView) => ({
  id: plan.id,
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
    data_plan: item.dataPlan,
    amount_naira: formatNaira(item.amountKobo),
    amount_usdc: formatUsdc(item.usdcMinor),
    payment_status: item.payment?.status ?? null,
    failure_reason: item.payment?.failureReason ?? null,
    tx_hash: item.payment?.fundingTxHash ?? null,
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
  ) {}

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentPlan(await this.plans.get(user.id, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.pins.check(user, pinIn(body));
    try {
      return presentPlan(await this.plans.approve(user, id));
    } catch (error) {
      if (error instanceof PlanRefused) throw new UnprocessableEntityException(error.message);
      throw error;
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
