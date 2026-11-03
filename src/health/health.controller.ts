import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async check() {
    try {
      await this.db.execute(sql`select 1`);
      // The web app reads the network from here and will not sign on a different one.
      return { status: 'ok', chain_id: this.config.get('CHAIN_ID', { infer: true }) };
    } catch {
      throw new ServiceUnavailableException('The database is unavailable');
    }
  }
}
