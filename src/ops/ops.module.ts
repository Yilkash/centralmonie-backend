import { Module } from '@nestjs/common';
import { SwitchesService } from './switches.service';

@Module({ providers: [SwitchesService], exports: [SwitchesService] })
export class OpsModule {}
