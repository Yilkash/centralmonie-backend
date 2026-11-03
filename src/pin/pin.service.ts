import { ForbiddenException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { User, users } from '../database/schema';
import { AuditService } from '../ops/audit.service';
import { hashPin, pinMatches, weakPin } from './pin';

const MAX_FAILURES = 5;

@Injectable()
export class PinService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  get required(): boolean {
    return this.config.get('REQUIRE_PIN', { infer: true });
  }

  /** Setting a PIN for the first time needs none. Changing one needs the current one. */
  async set(user: User, pin: string, current: string | undefined): Promise<void> {
    const weak = weakPin(pin);
    if (weak) throw new UnprocessableEntityException(weak);
    if (user.pinHash) await this.check(user, current);
    await this.db.update(users).set({ pinHash: await hashPin(pin), pinFailures: 0, pinLockedUntil: null }).where(eq(users.id, user.id));
    await this.audit.record(user.id, user.pinHash ? 'pin.changed' : 'pin.set');
  }

  /** Throws unless the PIN is right. Passes straight through when PINs are off and the user has none. */
  async check(user: User, pin: string | undefined): Promise<void> {
    if (!user.pinHash) {
      if (this.required) throw new ForbiddenException('Please set a PIN first.');
      return;
    }
    // A try is counted before the PIN is checked, in one step, so guesses sent together cannot share a count.
    const [counted] = await this.db
      .update(users)
      .set({
        pinFailures: sql`${users.pinFailures} + 1`,
        pinLockedUntil: sql`case when ${users.pinFailures} + 1 >= ${MAX_FAILURES} then now() + interval '30 minutes' else null end`,
      })
      .where(and(eq(users.id, user.id), or(isNull(users.pinLockedUntil), lte(users.pinLockedUntil, sql`now()`))))
      .returning();
    if (!counted) throw new ForbiddenException('Too many wrong PINs. Please try again in 30 minutes.');

    if (pin && (await pinMatches(pin, counted.pinHash!))) {
      await this.db.update(users).set({ pinFailures: 0, pinLockedUntil: null }).where(eq(users.id, user.id));
      return;
    }
    const locked = counted.pinFailures >= MAX_FAILURES;
    await this.audit.record(user.id, locked ? 'pin.locked' : 'pin.wrong');
    throw new ForbiddenException(locked ? 'Too many wrong PINs. Please try again in 30 minutes.' : 'That PIN is not right. Nothing was sent.');
  }

  /** For support, after confirming who someone is. */
  async reset(userId: string): Promise<void> {
    await this.db.update(users).set({ pinHash: null, pinFailures: 0, pinLockedUntil: null }).where(eq(users.id, userId));
  }
}
