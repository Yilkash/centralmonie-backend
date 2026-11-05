import { Module } from '@nestjs/common';
import { AgentApiModule } from '../agent-api/agent-api.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DepositsModule } from '../deposits/deposits.module';
import { PlansModule } from '../plans/plans.module';
import { ProvidersModule } from '../providers/providers.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { WalletModule } from '../wallet/wallet.module';
import { AgentChatResponder } from './agent-chat-responder';
import { AgentToolbox } from './agent-tools';
import { ClaudeModelClient, ModelClient } from './model-client';

@Module({
  imports: [AgentApiModule, ContactsModule, DepositsModule, PlansModule, ProvidersModule, WalletModule, SchedulesModule],
  providers: [AgentChatResponder, AgentToolbox, { provide: ModelClient, useClass: ClaudeModelClient }],
  exports: [AgentChatResponder],
})
export class AgentModule {}
