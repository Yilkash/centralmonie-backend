import { DepositsModule } from '../deposits/deposits.module';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentChatResponder } from '../agent/agent-chat-responder';
import { AgentModule } from '../agent/agent.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { AuthModule } from '../auth/auth.module';
import { Env } from '../config/env';
import { ContactsModule } from '../contacts/contacts.module';
import { PlansModule } from '../plans/plans.module';
import { ChatController } from './chat.controller';
import { ChatRepository } from './chat.repository';
import { ChatResponder } from './chat-responder';
import { ChatService } from './chat.service';
import { PlaceholderChatResponder } from './placeholder-chat-responder';

@Module({
  imports: [AuthModule, AgentModule, ContactsModule, DepositsModule, PlansModule, SchedulesModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatRepository,
    PlaceholderChatResponder,
    {
      provide: ChatResponder,
      inject: [ConfigService, AgentChatResponder, PlaceholderChatResponder],
      useFactory: (config: ConfigService<Env, true>, agent: AgentChatResponder, placeholder: PlaceholderChatResponder) =>
        config.get('ANTHROPIC_API_KEY', { infer: true }) ? agent : placeholder,
    },
  ],
})
export class ChatModule {}
