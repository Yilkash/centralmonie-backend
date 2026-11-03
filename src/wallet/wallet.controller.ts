import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { WalletService } from './wallet.service';

@Controller('v1')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  summary(@CurrentUser() user: User) {
    return this.wallet.summary(user);
  }

  @Get('activity')
  async activity(@CurrentUser() user: User) {
    return { activity: await this.wallet.activity(user.id) };
  }
}
