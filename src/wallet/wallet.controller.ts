import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { WalletService } from './wallet.service';

const PER_PAGE = 10;
const activityPage = z.coerce.number().int().min(1).max(10_000);

@Controller('v1')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  summary(@CurrentUser() user: User) {
    return this.wallet.summary(user);
  }

  @Get('activity')
  async activity(@CurrentUser() user: User, @Query('page') page?: string) {
    const parsed = activityPage.safeParse(page ?? '1');
    if (!parsed.success) throw new BadRequestException('That is not a page');
    return this.wallet.activityPage(user.id, parsed.data, PER_PAGE);
  }

  @Get('receipts/:kind/:id')
  async receipt(@CurrentUser() user: User, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string) {
    if (kind !== 'payment' && kind !== 'deposit') throw new NotFoundException('Receipt not found');
    const receipt = await this.wallet.receipt(user.id, kind, id);
    if (!receipt) throw new NotFoundException('Receipt not found');
    return { receipt };
  }
}
