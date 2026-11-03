import { ForbiddenException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { User, users } from '../database/schema';
import { AuditService } from '../ops/audit.service';
import { hashPin, pinMatches, weakPin } from './pin';

const MAX_FAILURES = 5;
const LOCK_MS = 30 * 60 * 1000;

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
    // Read fresh: the guard's copy could be from before another request failed.
    const [fresh] = await this.db.select().from(users).where(eq(users.id, user.id));
    if (fresh!.pinLockedUntil && fresh!.pinLockedUntil > new Date()) {
      throw new ForbiddenException('Too many wrong PINs. Please try again in 30 minutes.');
    }
    if (pin && (await pinMatches(pin, fresh!.pinHash!))) {
      if (fresh!.pinFailures > 0) await this.db.update(users).set({ pinFailures: 0, pinLockedUntil: null }).where(eq(users.id, user.id));
      return;
    }
    const failures = fresh!.pinFailures + 1;
    const locked = failures >= MAX_FAILURES;
    await this.db
      .update(users)
      .set({ pinFailures: locked ? 0 : failures, pinLockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null })
      .where(eq(users.id, user.id));
    await this.audit.record(user.id, locked ? 'pin.locked' : 'pin.wrong');
    throw new ForbiddenException(locked ? 'Too many wrong PINs. Please try again in 30 minutes.' : 'That PIN is not right. Nothing was sent.');
  }

  /** For support, after confirming who someone is. */
  async reset(userId: string): Promise<void> {
    await this.db.update(users).set({ pinHash: null, pinFailures: 0, pinLockedUntil: null }).where(eq(users.id, userId));
  }
}
