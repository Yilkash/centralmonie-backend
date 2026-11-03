import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, isNotNull } from 'drizzle-orm';
import { Env } from '../config/env';
import { Chain } from '../chain/chain.service';
import { DATABASE, Database } from '../database/database.module';
import { chainCursors, deposits, users } from '../database/schema';
import { formatUsdc } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';

const CURSOR = 'deposits';
const MAX_RANGE = 1000;
const FIRST_LOOK_BACK = 100;

/** Watches the chain for USDC arriving in users' wallets, and tells each user once. */
@Injectable()
export class DepositsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly chain: Chain,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async watch(): Promise<number> {
    const wallets = await this.db.select({ id: users.id, wallet: users.walletAddress }).from(users).where(isNotNull(users.walletAddress));
    const latest = await this.chain.latestBlock();
    const [cursor] = await this.db.select().from(chainCursors).where(eq(chainCursors.name, CURSOR));
    const from = cursor ? cursor.block + 1 : Math.max(latest - FIRST_LOOK_BACK, 0);
    if (from > latest) return 0;
    const to = Math.min(latest, from + MAX_RANGE);

    const collection = this.config.get('COLLECTION_ADDRESS', { infer: true })?.toLowerCase();
    let announced = 0;
    if (wallets.length > 0) {
      const owners = new Map(wallets.map((row) => [row.wallet!.toLowerCase(), row.id]));
      const seen = await this.chain.transfers({ to: wallets.map((row) => row.wallet!) }, from, to);
      for (const transfer of seen) {
        const userId = owners.get(transfer.to.toLowerCase());
        if (!userId || owners.get(transfer.from.toLowerCase()) === userId || transfer.value <= 0n) continue;
        // A refund already has its own message, so it is not announced as a deposit too.
        if (collection && transfer.from.toLowerCase() === collection) continue;
        const inserted = await this.db
          .insert(deposits)
          .values({ userId, txHash: transfer.txHash, logIndex: transfer.logIndex, fromAddress: transfer.from, usdcMinor: Number(transfer.value) })
          .onConflictDoNothing()
          .returning({ id: deposits.id });
        if (inserted.length === 0) continue;
        await this.notifications.notify(userId, `You received ${formatUsdc(Number(transfer.value))} in your wallet.`);
        announced += 1;
      }
    }
    await this.db
      .insert(chainCursors)
      .values({ name: CURSOR, block: to })
      .onConflictDoUpdate({ target: chainCursors.name, set: { block: to } });
    return announced;
  }
}
