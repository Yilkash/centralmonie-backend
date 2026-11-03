import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { ProvidersModule } from '../providers/providers.module';
import { NairaDepositsController } from './deposits.controller';
import { NairaDepositsService } from './deposits.service';

@Module({
  imports: [AuthModule, OpsModule, PaymentsModule, ProvidersModule],
  controllers: [NairaDepositsController],
  providers: [NairaDepositsService],
  exports: [NairaDepositsService],
})
export class DepositsModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly deposits: NairaDepositsService,
  ) {}

  onModuleInit(): void {
    this.worker.register({ name: 'naira-deposits', run: () => this.deposits.reconcile() });
  }
}
