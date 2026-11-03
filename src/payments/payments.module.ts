import { Module, OnModuleInit } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { DepositsService } from './deposits.service';
import { FundingService } from './funding.service';
import { LimitsService } from './limits.service';
import { PaymentEngine } from './payment-engine.service';
import { WorkerService } from './worker.service';

@Module({
  imports: [ProvidersModule],
  providers: [PaymentEngine, FundingService, LimitsService, DepositsService, WorkerService],
  exports: [PaymentEngine, FundingService, LimitsService, DepositsService, WorkerService],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly funding: FundingService,
    private readonly engine: PaymentEngine,
    private readonly deposits: DepositsService,
  ) {}

  onModuleInit(): void {
    this.worker.register({ name: 'funding', run: () => this.funding.reconcile() });
    this.worker.register({ name: 'delivery', run: () => this.engine.reconcile() });
    this.worker.register({ name: 'deposits', run: () => this.deposits.watch() });
  }
}
