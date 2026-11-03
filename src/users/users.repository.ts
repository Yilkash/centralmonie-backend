import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { User, users } from '../database/schema';
import { VerifiedIdentity } from '../identity/identity-provider';

@Injectable()
export class UsersRepository {
  private readonly logger = new Logger(UsersRepository.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * A wallet is only ever filled in, once. Permissions and refunds depend on it, so a different
   * address from the provider later is logged for a person to look at, and does not replace it.
   */
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
          walletAddress: sql`coalesce(${users.walletAddress}, excluded.wallet_address)`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (identity.walletAddress && user!.walletAddress?.toLowerCase() !== identity.walletAddress.toLowerCase()) {
      this.logger.error(`User ${user!.id} presented a different wallet from the saved one`);
    }
    return user!;
  }
}
