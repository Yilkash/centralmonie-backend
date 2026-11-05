import { BadRequestException, Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { WalletService } from './wallet.service';

const PER_PAGE = 6;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(value)));
const activityQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  direction: z.enum(['in', 'out']).optional(),
  type: z.enum(['bank', 'airtime', 'data', 'usdc', 'deposit', 'pay_link']).optional(),
  search: z.string().max(80).optional(),
  from: day.optional(),
  to: day.optional(),
});

@Controller('v1')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  summary(@CurrentUser() user: User) {
    return this.wallet.summary(user);
  }

  @Get('activity')
  async activity(@CurrentUser() user: User, @Query() query: unknown) {
    const parsed = activityQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Those filters are not valid');
    const { page, ...filters } = parsed.data;
    return this.wallet.activityPage(user.id, page, PER_PAGE, filters);
  }

  /** The filtered list as a file. Read through the app with the sign-in token, so it is never a public link. */
  @Get('activity/export')
  @Header('content-type', 'text/csv; charset=utf-8')
  async exportActivity(@CurrentUser() user: User, @Query() query: unknown) {
    const parsed = activityQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Those filters are not valid');
    const { page: _page, ...filters } = parsed.data;
    return this.wallet.activityCsv(user.id, filters);
  }

  @Get('receipts/:kind/:id')
  async receipt(@CurrentUser() user: User, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string) {
    if (kind !== 'payment' && kind !== 'deposit') throw new NotFoundException('Receipt not found');
    const receipt = await this.wallet.receipt(user.id, kind, id);
    if (!receipt) throw new NotFoundException('Receipt not found');
    return { receipt };
  }
}
