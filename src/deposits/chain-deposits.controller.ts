import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { ChainDepositsService, DEPOSIT_FROM, DepositRefused, presentChainDeposit } from './chain-deposits.service';

const startBody = z.object({
  pay_from: z.string().min(2).max(20),
  pay_token: z.enum(['USDC', 'USDT']).optional(),
  amount: z.string().min(1).max(20),
  refund_to: z.string().trim().min(2).max(120),
});

/** Deposits into the user's Base wallet from another network, through NEAR Intents. */
@Controller('v1/chain-deposits')
@UseGuards(AuthGuard)
export class ChainDepositsController {
  constructor(private readonly deposits: ChainDepositsService) {}

  /** The networks to choose from, the refund addresses already saved, and recent deposits. */
  @Get()
  async overview(@CurrentUser() user: User) {
    const [refunds, recent] = await Promise.all([this.deposits.refundAddresses(user.id), this.deposits.recent(user.id)]);
    return { networks: DEPOSIT_FROM, refund_addresses: refunds, deposits: recent.map(presentChainDeposit) };
  }

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return { deposit: presentChainDeposit(await this.deposits.get(user.id, id)) };
  }

  @Post()
  @HttpCode(200)
  async start(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = startBody.safeParse(body);
    if (!parsed.success) throw new DepositRefused('Choose a network, an amount and a refund address.');
    const { pay_from, pay_token, amount, refund_to } = parsed.data;
    return { deposit: presentChainDeposit(await this.deposits.start(user, { payFrom: pay_from, ...(pay_token ? { payToken: pay_token } : {}), amountUsdc: amount, refundTo: refund_to })) };
  }
}
