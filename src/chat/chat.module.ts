import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatController } from './chat.controller';
import { ChatRepository } from './chat.repository';
import { ChatResponder } from './chat-responder';
import { ChatService } from './chat.service';
import { PlaceholderChatResponder } from './placeholder-chat-responder';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository, { provide: ChatResponder, useClass: PlaceholderChatResponder }],
})
export class ChatModule {}
