import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { PinService } from '../pin/pin.service';
import { ContactsService } from './contacts.service';

@Controller('v1/contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly pins: PinService,
  ) {}

  @Post(':id/confirm')
  @HttpCode(204)
  async confirm(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    // A new recipient is where stolen access would try to send money, so it needs the PIN too.
    await this.pins.check(user, (body as { pin?: string } | null | undefined)?.pin);
    return this.contacts.confirm(user.id, id);
  }

  @Post(':id/discard')
  @HttpCode(204)
  discard(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.discard(user.id, id);
  }
}
