import { presentDeposit } from '../deposits/deposits.controller';
import { NairaDepositsService } from '../deposits/deposits.service';
import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

const chatId = z.string().uuid();
const renameChat = z.object({ title: z.string().trim().min(1).max(80) });
const sendMessage = z.object({ content: z.string().trim().min(1).max(6000), conversation_id: chatId.optional(), new_chat: z.boolean().optional() });
const contactConfirmed = z.object({ contact_id: z.string().uuid(), conversation_id: chatId.optional() });

@Controller('v1/chat/messages')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly plans: PlansService,
    private readonly contacts: ContactsService,
    private readonly schedules: SchedulesService,
    private readonly deposits: NairaDepositsService,
  ) {}

  private async present(user: User, message: ChatMessage) {
    const contact = message.contactId ? await this.contacts.get(user.id, message.contactId) : null;
    const cancelTarget = message.cancelScheduleId ? await this.schedules.get(user.id, message.cancelScheduleId) : null;
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      notice: message.notice,
      tx_hash: message.txHash,
      created_at: message.createdAt,
      plan: message.planId ? presentPlan(await this.plans.get(user.id, message.planId)) : null,
      schedule_group: message.scheduleGroupId ? presentGroup(await this.schedules.group(user.id, message.scheduleGroupId)) : null,
      cancel_schedule: cancelTarget && presentSchedule(cancelTarget),
      deposit: message.depositId ? presentDeposit(await this.deposits.get(user.id, message.depositId)) : null,
      contact: contact && {
        id: contact.id,
        name: contact.name,
        status: contact.status,
        // The whole address, because this card is the user's one chance to catch a wrong character.
        detail: contact.destinations[0]!.walletAddress ?? describeDestination(contact.destinations[0]!),
      },
    };
  }

  @Get('conversations')
  async conversations(@CurrentUser() user: User) {
    return { conversations: (await this.chat.conversations(user)).map((chat) => ({ id: chat.id, title: chat.title, updated_at: chat.updatedAt })) };
  }

  @Patch('conversations/:id')
  async rename(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = renameChat.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A chat name needs 1 to 80 characters');
    await this.chat.rename(user, id, parsed.data.title);
    return { ok: true };
  }

  @Delete('conversations/:id')
  async remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.chat.remove(user, id);
    return { ok: true };
  }

  @Get()
  async list(@CurrentUser() user: User, @Query('conversation') conversation?: string) {
    const id = conversation === undefined ? undefined : chatId.safeParse(conversation);
    if (id && !id.success) throw new BadRequestException('That is not a chat');
    const messages = await this.chat.history(user, id?.data);
    return { messages: await Promise.all(messages.filter((message) => !message.hidden).map((message) => this.present(user, message))) };
  }

  /** Lets the agent carry on after a contact card is confirmed. The server writes this message, not the client. */
  @Post('contact-confirmed')
  async afterContactConfirmed(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = contactConfirmed.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A contact is required');
    const contact = await this.contacts.get(user.id, parsed.data.contact_id);
    if (contact?.status !== 'confirmed') throw new BadRequestException('This contact is not confirmed');
    const message = `I confirmed ${contact.name}. Please continue.`;
    return { reply: await this.present(user, await this.chat.send(user, message, { conversationId: parsed.data.conversation_id }, { hidden: true })) };
  }

  @Post()
  async send(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = sendMessage.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A message needs 1 to 6000 characters');
    const saved = await this.chat.send(user, parsed.data.content, { conversationId: parsed.data.conversation_id, startNew: parsed.data.new_chat });
    return { reply: await this.present(user, saved), conversation_id: saved.conversationId };
  }
}
