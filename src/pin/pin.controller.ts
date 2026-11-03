import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { PinService } from './pin.service';

const body = z.object({ pin: z.string(), current_pin: z.string().optional() });

@Controller('v1/pin')
@UseGuards(AuthGuard)
export class PinController {
  constructor(private readonly pins: PinService) {}

  @Post()
  @HttpCode(200)
  async set(@CurrentUser() user: User, @Body() raw: unknown) {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('A PIN is required');
    await this.pins.set(user, parsed.data.pin, parsed.data.current_pin);
    return { has_pin: true };
  }
}
