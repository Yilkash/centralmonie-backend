import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { User, users } from '../database/schema';
import { VerifiedIdentity } from '../identity/identity-provider';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** A wallet is only ever filled in: a provider's temporary silence must not erase it. */
  async upsert(identity: VerifiedIdentity): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({
        providerSubject: identity.subject,
        email: identity.email,
        walletAddress: identity.walletAddress,
      })
      .onConflictDoUpdate({
        target: users.providerSubject,
        set: {
          email: sql`coalesce(excluded.email, ${users.email})`,
          walletAddress: sql`coalesce(excluded.wallet_address, ${users.walletAddress})`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return user!;
  }
}
