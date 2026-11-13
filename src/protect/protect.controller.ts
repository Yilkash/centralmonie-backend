import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { presentCheck, ProtectService } from './protect.service';

/** The user's own CentralMonie Protect history: every payment SERV checked, its answer and its reasons. */
@Controller('v1/protect')
@UseGuards(AuthGuard)
export class ProtectController {
  constructor(private readonly protect: ProtectService) {}

  @Get('checks')
  async checks(@CurrentUser() user: User) {
    return {
      enabled: this.protect.enabled,
      checks: (await this.protect.recent(user.id)).map((check) => ({ id: check.id, kind: check.subjectKind, subject_id: check.subjectId, ...presentCheck(check) })),
    };
  }
}

@Module({ imports: [AuthModule], controllers: [ProtectController] })
export class ProtectApiModule {}
