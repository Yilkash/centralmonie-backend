import { BadRequestException, Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { PinService } from '../pin/pin.service';
import { ContactRefused, ContactsService } from './contacts.service';

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

  @Post(':id/rename')
  @HttpCode(204)
  async rename(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const name = (body as { name?: unknown } | null | undefined)?.name;
    if (typeof name !== 'string') throw new BadRequestException('Give the new name.');
    try {
      await this.contacts.rename(user.id, id, name);
    } catch (error) {
      if (error instanceof ContactRefused) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Post(':id/discard')
  @HttpCode(204)
  discard(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.discard(user.id, id);
  }
}
