import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { NairaDeposit, User } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { NairaDepositsService } from './deposits.service';

const startBody = z.object({ amount_naira: z.number().int().positive() });

export const presentDeposit = (deposit: NairaDeposit | null) =>
  deposit && {
    id: deposit.id,
    status: deposit.status,
    amount: formatNaira(deposit.amountKobo),
    amount_naira: deposit.amountKobo / 100,
    usdc: formatUsdc(deposit.usdcMinor),
    rate: deposit.rate,
    bank_name: deposit.bankName,
    account_number: deposit.accountNumber,
    account_name: deposit.accountName,
    expires_at: deposit.expiresAt,
  };

@Controller('v1/deposits')
@UseGuards(AuthGuard)
export class NairaDepositsController {
  constructor(private readonly deposits: NairaDepositsService) {}

  @Get('terms')
  async terms() {
    const { nairaPerUsdc, minimumKobo, maximumKobo } = await this.deposits.terms();
    return { rate: nairaPerUsdc, minimum_naira: minimumKobo / 100, maximum_naira: maximumKobo / 100 };
  }

  @Get('current')
  async current(@CurrentUser() user: User) {
    return { deposit: presentDeposit(await this.deposits.current(user.id)) };
  }

  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return { deposit: presentDeposit(await this.deposits.get(user.id, id)) };
  }

  @Post()
  @HttpCode(200)
  async start(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = startBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Enter a whole naira amount.');
    return { deposit: presentDeposit(await this.deposits.start(user, parsed.data.amount_naira)) };
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.deposits.cancel(user.id, id);
    return { ok: true };
  }
}
