import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { AgentApiController, AgentKeyGuard, AgentKeysController, AgentX402Controller, PayLinksController, PublicPayLinksController, X402Guard } from './agent-api.controller';
import { AgentApiService } from './agent-api.service';
import { PayLinksService } from './pay-links.service';
import { CrossChain, OneClickCrossChain, SimulatedCrossChain } from './cross-chain';

@Module({
  imports: [AuthModule, OpsModule, PaymentsModule, ProvidersModule],
  controllers: [AgentApiController, AgentX402Controller, AgentKeysController, PayLinksController, PublicPayLinksController],
  providers: [
    AgentApiService,
    PayLinksService,
    AgentKeyGuard,
    X402Guard,
    {
      provide: CrossChain,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): CrossChain =>
        config.get('PAYMENTS_MODE', { infer: true }) === 'simulated'
          ? new SimulatedCrossChain()
          : new OneClickCrossChain(config.get('ONECLICK_API_KEY', { infer: true }), config.get('ONECLICK_BASE_URL', { infer: true })),
    },
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
