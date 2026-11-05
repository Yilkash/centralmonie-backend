import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { opSwitches } from '../database/schema';

export const SWITCH_NAMES = ['payments', 'schedules', 'airtime', 'data', 'bank', 'usdc', 'usdc_other_chains', 'deposits'] as const;
export type SwitchName = (typeof SWITCH_NAMES)[number];

/** Pause switches, read fresh each time so pausing takes effect on the very next payment. */
@Injectable()
export class SwitchesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async isPaused(name: SwitchName): Promise<boolean> {
    const [row] = await this.db.select().from(opSwitches).where(eq(opSwitches.name, name));
    return row?.paused ?? false;
  }

  async all(): Promise<Record<SwitchName, boolean>> {
    const rows = await this.db.select().from(opSwitches);
    return Object.fromEntries(SWITCH_NAMES.map((name) => [name, rows.find((row) => row.name === name)?.paused ?? false])) as Record<SwitchName, boolean>;
  }

  async set(name: SwitchName, paused: boolean): Promise<void> {
    await this.db
      .insert(opSwitches)
      .values({ name, paused })
      .onConflictDoUpdate({ target: opSwitches.name, set: { paused, updatedAt: new Date() } });
  }
}
