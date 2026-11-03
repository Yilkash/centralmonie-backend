import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { describeDestination, ContactsService } from '../contacts/contacts.service';
import { ChatMessage, User } from '../database/schema';
import { presentPlan } from '../plans/plans.controller';
import { PlansService } from '../plans/plans.service';
import { presentGroup, presentSchedule } from '../schedules/schedules.controller';
import { SchedulesService } from '../schedules/schedules.service';
import { ChatService } from './chat.service';

const sendMessage = z.object({ content: z.string().trim().min(1).max(2000) });
const contactConfirmed = z.object({ contact_id: z.string().uuid() });

@Controller('v1/chat/messages')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly plans: PlansService,
    private readonly contacts: ContactsService,
    private readonly schedules: SchedulesService,
  ) {}

  private async present(user: User, message: ChatMessage) {
    const contact = message.contactId ? await this.contacts.get(user.id, message.contactId) : null;
    const cancelTarget = message.cancelScheduleId ? await this.schedules.get(user.id, message.cancelScheduleId) : null;
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      notice: message.notice,
      created_at: message.createdAt,
      plan: message.planId ? presentPlan(await this.plans.get(user.id, message.planId)) : null,
      schedule_group: message.scheduleGroupId ? presentGroup(await this.schedules.group(user.id, message.scheduleGroupId)) : null,
      cancel_schedule: cancelTarget && presentSchedule(cancelTarget),
      contact: contact && {
        id: contact.id,
        name: contact.name,
        status: contact.status,
        // The whole address, because this card is the user's one chance to catch a wrong character.
        detail: contact.destinations[0]!.walletAddress ?? describeDestination(contact.destinations[0]!),
      },
    };
  }

  @Get()
  async list(@CurrentUser() user: User) {
    return { messages: await Promise.all((await this.chat.history(user)).filter((message) => !message.hidden).map((message) => this.present(user, message))) };
  }

  /** Lets the agent carry on after a contact card is confirmed. The server writes this message, not the client. */
  @Post('contact-confirmed')
  async afterContactConfirmed(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = contactConfirmed.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A contact is required');
    const contact = await this.contacts.get(user.id, parsed.data.contact_id);
    if (contact?.status !== 'confirmed') throw new BadRequestException('This contact is not confirmed');
    const message = `I confirmed ${contact.name}. Please continue.`;
    return { reply: await this.present(user, await this.chat.send(user, message, { hidden: true })) };
  }

  @Post()
  async send(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = sendMessage.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A message needs 1 to 2000 characters');
    return { reply: await this.present(user, await this.chat.send(user, parsed.data.content)) };
  }
}
