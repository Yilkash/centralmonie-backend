import { Module, OnModuleInit } from '@nestjs/common';
import { CrossChainModule } from '../agent-api/cross-chain.module';
import { AuthModule } from '../auth/auth.module';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { ChainDepositsController } from './chain-deposits.controller';
import { ChainDepositsService } from './chain-deposits.service';
import { NairaDepositsController } from './deposits.controller';
import { NairaDepositsService } from './deposits.service';

@Module({
  imports: [AuthModule, CrossChainModule, OpsModule, PaymentsModule, ProvidersModule],
  controllers: [NairaDepositsController, ChainDepositsController],
  providers: [NairaDepositsService, ChainDepositsService],
  exports: [NairaDepositsService, ChainDepositsService],
})
export class DepositsModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly deposits: NairaDepositsService,
    private readonly chainDeposits: ChainDepositsService,
  ) {}

  onModuleInit(): void {
    this.worker.register({ name: 'naira-deposits', run: () => this.deposits.reconcile() });
    this.worker.register({ name: 'chain-deposits', run: () => this.chainDeposits.reconcile() });
  }
}
