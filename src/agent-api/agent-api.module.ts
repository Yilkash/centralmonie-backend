import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { LiveNearExactFacilitator, LiveNearRelayer, NearExactFacilitator, NearRelayer } from './near-relay';
import { Module, OnModuleInit } from '@nestjs/common';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { AgentApiController, AgentKeyGuard, AgentKeysController, AgentX402Controller, PayLinksController, ProductLinksController, PublicPayLinksController, PublicProductLinksController, X402Guard } from './agent-api.controller';
import { AgentApiService } from './agent-api.service';
import { PayLinksService } from './pay-links.service';
import { MerchantController, MerchantKeyGuard, MerchantKeysController, OwnMerchantKeysController } from './merchant.controller';
import { MerchantService } from './merchant.service';
import { CrossChainModule } from './cross-chain.module';

@Module({
  imports: [AuthModule, CrossChainModule, OpsModule, PaymentsModule, ProvidersModule],
  controllers: [AgentApiController, AgentX402Controller, AgentKeysController, PayLinksController, PublicPayLinksController, ProductLinksController, PublicProductLinksController, MerchantController, MerchantKeysController, OwnMerchantKeysController],
  providers: [
    AgentApiService,
    PayLinksService,
    MerchantService,
    MerchantKeyGuard,
    AgentKeyGuard,
    X402Guard,
    {
      provide: NearRelayer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): NearRelayer | null => {
        const account = config.get('NEAR_RELAYER_ACCOUNT_ID', { infer: true });
        const key = config.get('NEAR_RELAYER_PRIVATE_KEY', { infer: true });
        return account && key ? new LiveNearRelayer(account, key, config.get('NEAR_RPC_URL', { infer: true })) : null;
      },
    },
    {
      // The same relayer account sponsors standard x402 payments on NEAR.
      provide: NearExactFacilitator,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): NearExactFacilitator | null => {
        const account = config.get('NEAR_RELAYER_ACCOUNT_ID', { infer: true });
        const key = config.get('NEAR_RELAYER_PRIVATE_KEY', { infer: true });
        return account && key ? new LiveNearExactFacilitator(account, key, config.get('NEAR_RPC_URL', { infer: true })) : null;
      },
    },
  ],
  exports: [PayLinksService],
})
export class AgentApiModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly agents: AgentApiService,
    private readonly merchants: MerchantService,
  ) {}

  onModuleInit(): void {
    if (this.agents.open) this.worker.register({ name: 'agent-payments', run: () => this.agents.reconcile() });
    this.worker.register({ name: 'merchant-notices', run: () => this.merchants.reconcile() });
  }
}
