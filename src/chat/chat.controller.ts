import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatMessage, User } from '../database/schema';
import { ChatService } from './chat.service';

const sendMessage = z.object({ content: z.string().trim().min(1).max(2000) });

const present = (message: ChatMessage) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  created_at: message.createdAt,
});

@Controller('v1/chat/messages')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return { messages: (await this.chat.history(user)).map(present) };
  }

  @Post()
  async send(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = sendMessage.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A message needs 1 to 2000 characters');
    return { reply: present(await this.chat.send(user, parsed.data.content)) };
  }
}
