import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { GuardsService } from './guards.service';
import { SwitchesService } from './switches.service';

@Global()
@Module({ providers: [SwitchesService, AuditService, GuardsService], exports: [SwitchesService, AuditService, GuardsService] })
export class OpsModule {}
