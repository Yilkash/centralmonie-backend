import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { AgentApiController, AgentKeyGuard, AgentKeysController } from './agent-api.controller';
import { AgentApiService } from './agent-api.service';
import { CrossChain, OneClickCrossChain, SimulatedCrossChain } from './cross-chain';

@Module({
  imports: [OpsModule, PaymentsModule, ProvidersModule],
  controllers: [AgentApiController, AgentKeysController],
  providers: [
    AgentApiService,
    AgentKeyGuard,
    {
      provide: CrossChain,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): CrossChain =>
        config.get('PAYMENTS_MODE', { infer: true }) === 'simulated'
          ? new SimulatedCrossChain()
          : new OneClickCrossChain(config.get('ONECLICK_API_KEY', { infer: true }), config.get('ONECLICK_BASE_URL', { infer: true })),
    },
  ],
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
