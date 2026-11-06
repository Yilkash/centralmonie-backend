import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { isAddress } from 'viem';
import { validRefundAddress } from '../agent-api/agent-api.service';
import { CrossChain, PAY_FROM, PayFrom, PayToken, USDT_ON, USDT_ONLY } from '../agent-api/cross-chain';
import { ChainKey, USDC_CHAINS } from '../chain/usdc-chains';
import { DATABASE, Database } from '../database/database.module';
import { ChainDeposit, chainDeposits, refundAddresses, User } from '../database/schema';
import { formatUsdc, parseUsdc } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../ops/audit.service';
import { SwitchesService } from '../ops/switches.service';

/** How long the one-time address takes deposits. A deposit after it goes back to the refund address. */
const DEPOSIT_WINDOW_MS = 30 * 60_000;
/** A deposit sent just before the deadline can take a while to show up, so it is watched this much longer. */
const WATCH_AFTER_DEADLINE_MS = 60 * 60_000;
const MAX_A_DAY = 20;
const SMALLEST_MINOR = 1_000_000;
const LARGEST_MINOR = 5_000_000_000;
const OPEN = ['waiting', 'moving'];

export type RefundFamily = 'evm' | 'near' | 'solana' | 'tron' | 'ton' | 'sui' | 'aptos';

/** Every 0x network shares one address, so one saved refund address serves them all. */
export function refundFamily(payFrom: PayFrom): RefundFamily {
  if (payFrom === 'near' || payFrom === 'solana' || payFrom === 'tron' || payFrom === 'ton' || payFrom === 'sui' || payFrom === 'aptos') return payFrom;
  return 'evm';
}

/** The networks a deposit can come from, and the tokens each takes. Base is left out: a Base deposit goes straight to the wallet. */
export const DEPOSIT_FROM = (Object.keys(PAY_FROM) as PayFrom[])
  .filter((key) => key !== 'base')
  .map((key) => ({
    id: key,
    name: USDC_CHAINS[key as ChainKey]?.name ?? key,
    tokens: (USDT_ONLY.has(key) ? ['USDT'] : USDT_ON[key] ? ['USDC', 'USDT'] : ['USDC']) as PayToken[],
    family: refundFamily(key),
  }));

export class DepositRefused extends UnprocessableEntityException {}

/** A sentence about why NEAR Intents would not set up the deposit, with nothing from the partner the user should not see. */
export function depositProblem(error: unknown, network: string): string {
  const text = String((error as Error)?.message ?? '');
  if (/too low/i.test(text)) return `That amount is too small to deposit from ${network}. Nothing was set up. Try a larger amount.`;
  const limit = /minimum swap amount is (\$[\d,]+)/i.exec(text);
  if (limit) return `Deposits from ${network} start at ${limit[1]} for the moment. Nothing was set up.`;
  if (/not available/i.test(text)) return `Deposits from ${network} are not available right now. Nothing was set up. Please try again later.`;
  return `We could not set up a deposit from ${network} just now. Nothing was set up. Please try again in a moment.`;
}

/** Money from another network into the user's own Base wallet, through NEAR Intents. We only follow it. */
@Injectable()
export class ChainDepositsService {
  private readonly logger = new Logger(ChainDepositsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly crossChain: CrossChain,
    private readonly notifications: NotificationsService,
    private readonly switches: SwitchesService,
    private readonly audit: AuditService,
  ) {}

  async refundAddresses(userId: string): Promise<Partial<Record<RefundFamily, string>>> {
    const rows = await this.db.select().from(refundAddresses).where(eq(refundAddresses.userId, userId));
    return Object.fromEntries(rows.map((row) => [row.family, row.address]));
  }

  async start(user: User, input: { payFrom: string; payToken?: PayToken; amountUsdc: string; refundTo: string }): Promise<ChainDeposit> {
    if (!user.walletAddress) throw new DepositRefused('Your wallet is still being set up. Please try again in a moment.');
    if ((await this.switches.isPaused('deposits')) || (await this.switches.isPaused('usdc_other_chains'))) {
      throw new ServiceUnavailableException('Deposits from other networks are paused for the moment. Nothing was set up.');
    }
    const network = DEPOSIT_FROM.find((item) => item.id === input.payFrom);
    if (!network) throw new DepositRefused(`Deposits can come from ${DEPOSIT_FROM.map((item) => item.name).join(', ')}. For Base, send to your wallet address directly.`);
    // Tron and TON have only USDT, so it needs no choosing. Elsewhere a token that cannot be sent is refused, not swapped.
    const payToken: PayToken = USDT_ONLY.has(network.id) ? 'USDT' : (input.payToken ?? 'USDC');
    if (!network.tokens.includes(payToken)) throw new DepositRefused(`${payToken} cannot be sent from ${network.name}. Use ${network.tokens.join(' or ')}.`);

    const amountMinor = parseUsdc(input.amountUsdc.trim());
    if (amountMinor === null) throw new DepositRefused('Enter an amount such as 10 or 25.50.');
    if (amountMinor < SMALLEST_MINOR) throw new DepositRefused(`The smallest deposit is ${formatUsdc(SMALLEST_MINOR).replace('USDC', payToken)}.`);
    if (amountMinor > LARGEST_MINOR) throw new DepositRefused(`The largest deposit is ${formatUsdc(LARGEST_MINOR).replace('USDC', payToken)}.`);

    const refundTo = input.refundTo.trim();
    if (!validRefundAddress(network.id, refundTo)) throw new DepositRefused(`That is not a valid ${network.name} address for refunds. Please check it was copied in full.`);
    // The 10kobo wallet is a smart wallet that exists only on Base. The same 0x address elsewhere belongs to nobody.
    if (isAddress(refundTo) && refundTo.toLowerCase() === user.walletAddress.toLowerCase()) {
      throw new DepositRefused(`That is your 10kobo wallet, which only exists on Base. A refund sent to it on ${network.name} would be lost. Use your own ${network.name} wallet.`);
    }

    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(chainDeposits)
      .where(and(eq(chainDeposits.userId, user.id), gte(chainDeposits.createdAt, new Date(Date.now() - 24 * 60 * 60_000))));
    if (count >= MAX_A_DAY) throw new DepositRefused('You have started too many deposits today. Please try again tomorrow.');

    const deadline = new Date(Date.now() + DEPOSIT_WINDOW_MS);
    const quote = await this.crossChain
      .depositToBase({ payFrom: network.id, payToken, amountMinor, recipient: user.walletAddress, refundTo, deadline })
      .catch((error: unknown) => {
        throw new DepositRefused(depositProblem(error, network.name));
      });

    const [row] = await this.db
      .insert(chainDeposits)
      .values({ id: randomUUID(), userId: user.id, payFrom: network.id, payToken, amountMinor, quotedMinor: quote.receiverMinor, refundTo, depositAddress: quote.depositAddress, deadline })
      .returning();
    await this.db
      .insert(refundAddresses)
      .values({ userId: user.id, family: network.family, address: refundTo })
      .onConflictDoUpdate({ target: [refundAddresses.userId, refundAddresses.family], set: { address: refundTo, updatedAt: new Date() } });
    await this.audit.record(user.id, 'chain_deposit.started', row!.id, { payFrom: network.id, payToken, amountMinor });
    return row!;
  }

  async get(userId: string, id: string): Promise<ChainDeposit> {
    const [row] = await this.db.select().from(chainDeposits).where(and(eq(chainDeposits.id, id), eq(chainDeposits.userId, userId)));
    if (!row) throw new NotFoundException('Deposit not found');
    return row;
  }

  recent(userId: string): Promise<ChainDeposit[]> {
    return this.db.select().from(chainDeposits).where(eq(chainDeposits.userId, userId)).orderBy(desc(chainDeposits.createdAt)).limit(10);
  }

  /** Follows each open deposit through NEAR Intents, and tells the user how it ended. */
  async reconcile(): Promise<void> {
    const open = await this.db
      .select()
      .from(chainDeposits)
      .where(and(inArray(chainDeposits.status, OPEN), gte(chainDeposits.createdAt, new Date(Date.now() - 2 * 24 * 60 * 60_000))));
    for (const deposit of open) {
      try {
        await this.follow(deposit);
      } catch (error) {
        this.logger.warn(`chain deposit ${deposit.id} could not be checked: ${(error as Error).message.slice(0, 200)}`);
      }
    }
  }

  private async follow(deposit: ChainDeposit): Promise<void> {
    const state = await this.crossChain.status(deposit.depositAddress);
    const name = USDC_CHAINS[deposit.payFrom as ChainKey]?.name ?? deposit.payFrom;
    const move = async (values: Partial<ChainDeposit>, text?: string) => {
      const moved = await this.db
        .update(chainDeposits)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(chainDeposits.id, deposit.id), eq(chainDeposits.status, deposit.status)))
        .returning({ id: chainDeposits.id });
      if (moved.length > 0 && text) await this.notifications.notify(deposit.userId, text);
    };
    const transactions = state.transactions.length > 0 ? state.transactions : deposit.transactions;
    switch (state.status) {
      case 'delivered': {
        const received = state.receivedMinor ?? deposit.quotedMinor;
        return move({ status: 'delivered', receivedMinor: received, transactions }, `${formatUsdc(deposit.amountMinor).replace('USDC', deposit.payToken)} from ${name} arrived: ${formatUsdc(received)} added to your wallet.`);
      }
      case 'refunded':
        return move({ status: 'refunded', transactions }, `Your deposit from ${name} could not be completed, so it was sent back to your ${name} address, less a small fee.`);
      case 'failed':
        return move({ status: 'failed', transactions }, `Your deposit from ${name} failed. Our team is checking it. Please do not send it again.`);
      case 'moving':
        return deposit.status === 'moving' ? undefined : move({ status: 'moving', transactions });
      default:
        // Nothing arrived in time. Anything sent late goes back to the refund address by itself.
        if (deposit.deadline.getTime() + WATCH_AFTER_DEADLINE_MS < Date.now()) return move({ status: 'expired' });
    }
  }
}

export const presentChainDeposit = (deposit: ChainDeposit) => {
  const chain = USDC_CHAINS[deposit.payFrom as ChainKey];
  const tx = (hash: string) => (hash.startsWith('0x') && hash.length === 66 ? `https://basescan.org/tx/${hash}` : null);
  return {
    id: deposit.id,
    status: deposit.status,
    pay_from: deposit.payFrom,
    network: chain?.name ?? deposit.payFrom,
    token: deposit.payToken,
    send: formatUsdc(deposit.amountMinor).replace(' USDC', ''),
    send_exact: (deposit.amountMinor / 1_000_000).toFixed(6),
    you_get: formatUsdc(deposit.quotedMinor),
    received: deposit.receivedMinor ? formatUsdc(deposit.receivedMinor) : null,
    deposit_address: deposit.depositAddress,
    refund_to: deposit.refundTo,
    deadline: deposit.deadline,
    created_at: deposit.createdAt,
    delivery_tx_url: deposit.status === 'delivered' ? (deposit.transactions.map(tx).filter(Boolean).at(-1) ?? null) : null,
  };
};
