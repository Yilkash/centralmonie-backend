import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { ContactsService } from './contacts.service';

@Controller('v1/contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Post(':id/confirm')
  @HttpCode(204)
  confirm(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.confirm(user.id, id);
  }

  @Post(':id/discard')
  @HttpCode(204)
  discard(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.discard(user.id, id);
  }
}
