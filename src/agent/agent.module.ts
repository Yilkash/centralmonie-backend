import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { PlansModule } from '../plans/plans.module';
import { ProvidersModule } from '../providers/providers.module';
import { WalletModule } from '../wallet/wallet.module';
import { AgentChatResponder } from './agent-chat-responder';
import { AgentToolbox } from './agent-tools';
import { ClaudeModelClient, ModelClient } from './model-client';

@Module({
  imports: [ContactsModule, PlansModule, ProvidersModule, WalletModule],
  providers: [AgentChatResponder, AgentToolbox, { provide: ModelClient, useClass: ClaudeModelClient }],
  exports: [AgentChatResponder],
})
export class AgentModule {}
