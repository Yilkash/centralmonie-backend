import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE, Database } from '../database/database.module';
import { auditLog } from '../database/schema';

/** A failed audit write is logged but never stops a payment or leaves one half done. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(actor: string, action: string, subject?: string | null, details?: unknown): Promise<void> {
    await this.db
      .insert(auditLog)
      .values({ actor, action, subject: subject ?? null, details: details ?? null })
      .catch((error: Error) => this.logger.error(`Audit write failed for ${action}: ${error.name}`));
  }
}
