import { Module, OnModuleInit } from '@nestjs/common';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { AgentApiController, AgentKeyGuard, AgentKeysController, AgentX402Controller, PayLinksController, PublicPayLinksController, X402Guard } from './agent-api.controller';
import { AgentApiService } from './agent-api.service';
import { PayLinksService } from './pay-links.service';
import { CrossChainModule } from './cross-chain.module';

@Module({
  imports: [AuthModule, CrossChainModule, OpsModule, PaymentsModule, ProvidersModule],
  controllers: [AgentApiController, AgentX402Controller, AgentKeysController, PayLinksController, PublicPayLinksController],
  providers: [
    AgentApiService,
    PayLinksService,
    AgentKeyGuard,
    X402Guard,
  ],
  exports: [PayLinksService],
})
export class AgentApiModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly agents: AgentApiService,
  ) {}

  onModuleInit(): void {
    if (this.agents.open) this.worker.register({ name: 'agent-payments', run: () => this.agents.reconcile() });
  }
}
