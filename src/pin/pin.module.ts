import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PinController } from './pin.controller';
import { PinService } from './pin.service';

@Global()
@Module({ imports: [AuthModule], controllers: [PinController], providers: [PinService], exports: [PinService] })
export class PinModule {}
