import { BadRequestException, Body, Controller, Get, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/current-user.decorator';
import { User } from '../database/schema';
import { FILE_TYPES, FileReaderService, MAX_FILE_BYTES } from './file-reader';
import { presentCheck, ProtectService } from './protect.service';

export const READ_FILE_PATH = '/v1/protect/read-file';
const readFile = z.object({ file_name: z.string().max(200), mime_type: z.enum(FILE_TYPES), data_base64: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8) });

/** The user's own CentralMonie Protect history: every payment SERV checked, its answer and its reasons. */
@Controller('v1/protect')
@UseGuards(AuthGuard)
export class ProtectController {
  constructor(
    private readonly protect: ProtectService,
    private readonly files: FileReaderService,
  ) {}

  /** An invoice photo or PDF, read by SERV Reasoning before it reaches the chat. Hidden text is listed apart. */
  @Post('read-file')
  @HttpCode(200)
  async readFile(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = readFile.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Send a photo (JPG, PNG or WebP) or a PDF, up to 5 MB.');
    return this.files.read(user.id, parsed.data.file_name, parsed.data.mime_type, Buffer.from(parsed.data.data_base64, 'base64'));
  }

  @Get('checks')
  async checks(@CurrentUser() user: User) {
    return {
      enabled: this.protect.enabled,
      checks: (await this.protect.recent(user.id)).map((check) => ({ id: check.id, kind: check.subjectKind, subject_id: check.subjectId, ...presentCheck(check) })),
    };
  }
}

@Module({ imports: [AuthModule], controllers: [ProtectController], providers: [FileReaderService] })
export class ProtectApiModule {}
