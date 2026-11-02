import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { PlanRefused, PlansService, PlanView } from './plans.service';

export const presentPlan = (plan: PlanView) => ({
  id: plan.id,
  status: plan.status,
  quote_expires_at: plan.quoteExpiresAt,
  total_naira: formatNaira(plan.totalKobo),
  total_usdc: formatUsdc(plan.totalUsdcMinor),
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
  })),
});

@Controller('v1/plans')
@UseGuards(AuthGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentPlan(await this.plans.get(user.id, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return presentPlan(await this.plans.approve(user.id, id));
    } catch (error) {
      if (error instanceof PlanRefused) throw new UnprocessableEntityException(error.message);
      throw error;
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentPlan(await this.plans.reject(user.id, id));
  }
}
