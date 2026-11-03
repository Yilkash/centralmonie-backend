import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { PinService } from '../pin/pin.service';

@Controller('v1/me')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly pins: PinService) {}

  @Get()
  me(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      wallet_address: user.walletAddress,
      has_pin: Boolean(user.pinHash),
      pin_required: this.pins.required,
    };
  }
}
