import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OpsModule } from '../ops/ops.module';
import { PaymentsModule } from '../payments/payments.module';
import { WorkerService } from '../payments/worker.service';
import { PlansModule } from '../plans/plans.module';
import { ProvidersModule } from '../providers/providers.module';
import { SchedulerService } from './scheduler.service';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  imports: [AuthModule, PaymentsModule, PlansModule, ProvidersModule, OpsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerService],
  exports: [SchedulesService, SchedulerService],
})
export class SchedulesModule implements OnModuleInit {
  constructor(
    private readonly worker: WorkerService,
    private readonly scheduler: SchedulerService,
    private readonly schedules: SchedulesService,
  ) {}

  onModuleInit(): void {
    this.worker.register({ name: 'schedule-cleanup', run: () => this.schedules.reconcile() });
    this.worker.register({ name: 'scheduler', run: () => this.scheduler.tick() });
  }
}
