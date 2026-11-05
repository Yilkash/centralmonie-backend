import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, gte, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DATABASE, Database } from '../database/database.module';
import { AgentPayment, agentPayments, MerchantKey, merchantEvents, merchantKeys, PayLink, payLinks, User, users } from '../database/schema';
import { isAddress } from 'viem';
import { isNearAccount } from '../chain/usdc-chains';
import { AgentRefusal, hashKey } from './agent-api.service';
import { LinkInput, PayLinksService, presentOwnLink } from './pay-links.service';

/** The notices a shop can get. Each is final for its invoice, so each is sent once. */
export type MerchantEventType = 'invoice.paid' | 'invoice.cancelled' | 'invoice.expired';
const STATUS_EVENT: Record<string, MerchantEventType> = { paid: 'invoice.paid', cancelled: 'invoice.cancelled', expired: 'invoice.expired' };
/** About a day of retries: 1, 2, 4 … minutes, then every 6 hours. */
const MAX_ATTEMPTS = 12;
const LONGEST_WAIT_MS = 6 * 60 * 60_000;
const NOTICE_TIMEOUT_MS = 5000;

export interface NewMerchantKey {
  userEmail: string;
  name: string;
  /** Where every invoice from this key pays out: naira to a bank, or USDC to the owner's wallet, a Base address or a NEAR account. */
  payout: { bankName: string; accountNumber: string } | { toMyWallet: true } | { usdcAddress: string } | { nearAccount: string };
  returnOrigins?: string[];
  webhookUrl?: string | null;
  invoicesPerDay?: number;
}

export interface MerchantInvoiceInput extends Pick<LinkInput, 'amountNaira' | 'note' | 'dueDate' | 'lineItems'> {
  reference: string;
  returnUrl?: string | null;
}

/** Plain http is allowed only for a server on this same machine, for local testing. */
function webAddress(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentRefusal('invalid_request', `The ${what} is not a valid web address.`, 400);
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new AgentRefusal('invalid_request', `The ${what} must use https.`, 400);
  if (url.username || url.password) throw new AgentRefusal('invalid_request', `The ${what} must not contain a password.`, 400);
  return url;
}

/** Shows a shop exactly how to check a notice: the time, a dot, then the body, signed with its webhook secret. */
export function signNotice(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Lets a shop take payment through a checkout button. The shop's server makes invoices with a secret key, payers pay
 * on our pay link page, and the shop's server is told when an invoice is paid. Every payment limit of pay links applies.
 */
@Injectable()
export class MerchantService {
  private readonly logger = new Logger(MerchantService.name);
  /** Replaced in tests. */
  fetchFn: typeof fetch = fetch;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly links: PayLinksService,
  ) {}

  /** The key and webhook secret are shown once, here, and only their hash or the secret for signing is kept. */
  async createKey(input: NewMerchantKey): Promise<{ id: string; key: string; webhookSecret: string | null }> {
    const [owner] = await this.db.select().from(users).where(eq(users.email, input.userEmail.trim().toLowerCase()));
    if (!owner) throw new AgentRefusal('not_found', 'No 10kobo user has that email.', 404);
    const origins = (input.returnOrigins ?? []).map((origin) => {
      const url = webAddress(origin, 'return website');
      if (url.origin !== origin.replace(/\/$/, '')) throw new AgentRefusal('invalid_request', 'A return website is just the start of an address, such as https://shop.example.', 400);
      return url.origin;
    });
    if (input.webhookUrl) webAddress(input.webhookUrl, 'notice address');
    let payout: Partial<typeof merchantKeys.$inferInsert>;
    if ('toMyWallet' in input.payout) {
      if (!owner.walletAddress) throw new AgentRefusal('wallet_not_ready', 'That user has no 10kobo wallet yet.', 409);
      payout = { payoutToWallet: true };
    } else if ('usdcAddress' in input.payout) {
      if (!isAddress(input.payout.usdcAddress)) throw new AgentRefusal('invalid_request', 'That is not a valid Base address.', 400);
      payout = { payoutUsdcAddress: input.payout.usdcAddress };
    } else if ('nearAccount' in input.payout) {
      if (!isNearAccount(input.payout.nearAccount)) throw new AgentRefusal('invalid_request', 'That is not a valid NEAR account.', 400);
      payout = { payoutNearAccount: input.payout.nearAccount };
    } else {
      if (!/^\d{10}$/.test(input.payout.accountNumber)) throw new AgentRefusal('invalid_request', 'A bank account number has 10 digits.', 400);
      payout = { payoutBankName: input.payout.bankName, payoutAccountNumber: input.payout.accountNumber };
    }
    const key = `mk_${randomBytes(32).toString('base64url')}`;
    const webhookSecret = input.webhookUrl ? `whsec_${randomBytes(32).toString('base64url')}` : null;
    const [row] = await this.db
      .insert(merchantKeys)
      .values({ userId: owner.id, name: input.name.trim(), keyHash: hashKey(key), ...payout, returnOrigins: origins, webhookUrl: input.webhookUrl ?? null, webhookSecret, invoicesPerDay: input.invoicesPerDay ?? 200 })
      .returning();
    return { id: row!.id, key, webhookSecret };
  }

  async revokeKey(id: string): Promise<boolean> {
    const rows = await this.db.update(merchantKeys).set({ revokedAt: new Date() }).where(and(eq(merchantKeys.id, id), isNull(merchantKeys.revokedAt))).returning({ id: merchantKeys.id });
    return rows.length > 0;
  }

  async keyFrom(key: string): Promise<{ key: MerchantKey; owner: User } | null> {
    if (!key.startsWith('mk_')) return null;
    const [row] = await this.db.select({ key: merchantKeys, owner: users }).from(merchantKeys).innerJoin(users, eq(merchantKeys.userId, users.id)).where(eq(merchantKeys.keyHash, hashKey(key)));
    return row && !row.key.revokedAt ? row : null;
  }

  /** The same reference twice gives the same invoice, so a shop can safely retry. A different amount for it is refused. */
  async createInvoice(key: MerchantKey, owner: User, input: MerchantInvoiceInput): Promise<PayLink> {
    const existing = await this.byReference(key.id, input.reference);
    if (existing) return this.sameInvoice(existing, input);

    let returnUrl: string | null = null;
    if (input.returnUrl) {
      const url = webAddress(input.returnUrl, 'return address');
      if (!key.returnOrigins.includes(url.origin)) throw new AgentRefusal('invalid_request', 'The return address must be on a website registered for this key.', 400);
      returnUrl = url.toString();
    }
    const [{ made } = { made: 0 }] = await this.db
      .select({ made: count() })
      .from(payLinks)
      .where(and(eq(payLinks.merchantKeyId, key.id), gte(payLinks.createdAt, sql`now() - interval '1 day'`)));
    if (made >= key.invoicesPerDay) throw new AgentRefusal('too_many_requests', 'This key has made its most invoices for today.', 429);

    const payout = key.payoutToWallet
      ? { toMyWallet: true }
      : key.payoutUsdcAddress
        ? { usdcAddress: key.payoutUsdcAddress }
        : key.payoutNearAccount
          ? { nearAccount: key.payoutNearAccount }
          : { bankName: key.payoutBankName, accountNumber: key.payoutAccountNumber };
    try {
      return await this.links.create(owner, { ...payout, amountNaira: input.amountNaira ?? null, note: input.note ?? null, dueDate: input.dueDate ?? null, lineItems: input.lineItems ?? null }, { keyId: key.id, reference: input.reference, returnUrl });
    } catch (error) {
      // Two requests with one reference at once: the database lets only one in, and the other gets that same invoice.
      const raced = await this.byReference(key.id, input.reference);
      if (raced) return this.sameInvoice(raced, input);
      throw error;
    }
  }

  private async byReference(keyId: string, reference: string): Promise<PayLink | null> {
    const [link] = await this.db.select().from(payLinks).where(and(eq(payLinks.merchantKeyId, keyId), eq(payLinks.reference, reference)));
    return link ?? null;
  }

  private sameInvoice(link: PayLink, input: MerchantInvoiceInput): PayLink {
    const total = input.amountNaira ?? input.lineItems?.reduce((sum, item) => sum + item.amountNaira, 0) ?? null;
    if (total !== null && total * 100 !== link.amountKobo) throw new AgentRefusal('reference_used', 'That reference already has an invoice for a different amount.', 409);
    return link;
  }

  async invoice(key: MerchantKey, id: string): Promise<{ link: PayLink; payment: AgentPayment | null }> {
    const [row] = await this.db
      .select({ link: payLinks, payment: agentPayments })
      .from(payLinks)
      .leftJoin(agentPayments, eq(payLinks.paymentId, agentPayments.id))
      .where(and(eq(payLinks.id, id), eq(payLinks.merchantKeyId, key.id)));
    if (!row) throw new AgentRefusal('not_found', 'This key has no such invoice.', 404);
    return row;
  }

  async cancel(key: MerchantKey, owner: User, id: string): Promise<PayLink> {
    await this.invoice(key, id);
    return this.links.cancel(owner, id);
  }

  present(row: { link: PayLink; payment: AgentPayment | null }) {
    return { ...presentOwnLink(row, this.links.url(row.link)), reference: row.link.reference, checkout_url: this.links.url(row.link), return_url: row.link.returnUrl };
  }

  /** Finds invoices that reached an end state with no notice yet, and makes one notice for each. */
  async queueNotices(): Promise<number> {
    const rows = await this.db
      .select({ link: payLinks, payment: agentPayments, key: merchantKeys })
      .from(payLinks)
      .innerJoin(merchantKeys, eq(payLinks.merchantKeyId, merchantKeys.id))
      .leftJoin(agentPayments, eq(payLinks.paymentId, agentPayments.id))
      .where(
        and(
          isNotNull(merchantKeys.webhookUrl),
          or(eq(agentPayments.status, 'paid'), isNotNull(payLinks.cancelledAt), lt(payLinks.expiresAt, new Date())),
          sql`not exists (select 1 from ${merchantEvents} where ${merchantEvents.linkId} = ${payLinks.id})`,
        ),
      )
      .limit(100);
    let queued = 0;
    for (const row of rows) {
      const invoice = this.present(row);
      const type = STATUS_EVENT[invoice.status];
      if (!type) continue;
      const id = randomUUID();
      const inserted = await this.db
        .insert(merchantEvents)
        .values({ id, keyId: row.key.id, linkId: row.link.id, type, payload: { id, type, created_at: new Date().toISOString(), data: invoice } })
        .onConflictDoNothing()
        .returning({ id: merchantEvents.id });
      queued += inserted.length;
    }
    return queued;
  }

  /** Sends notices that are due. A shop answering with any 2xx means it has it; anything else is tried again later. */
  async deliverNotices(): Promise<number> {
    const due = await this.db
      .select({ event: merchantEvents, key: merchantKeys })
      .from(merchantEvents)
      .innerJoin(merchantKeys, eq(merchantEvents.keyId, merchantKeys.id))
      .where(and(isNull(merchantEvents.deliveredAt), lte(merchantEvents.nextAttemptAt, sql`now()`), lt(merchantEvents.attempts, MAX_ATTEMPTS), isNull(merchantKeys.revokedAt)))
      .limit(20);
    let delivered = 0;
    for (const { event, key } of due) {
      const body = JSON.stringify(event.payload);
      let problem: string | null = null;
      try {
        if (!key.webhookUrl || !key.webhookSecret) throw new Error('no notice address');
        const response = await this.fetchFn(key.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', '10kobo-event-id': event.id, '10kobo-signature': signNotice(key.webhookSecret, Math.floor(Date.now() / 1000), body) },
          body,
          // A redirect could point anywhere, so it counts as a failure.
          redirect: 'manual',
          signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
        });
        if (response.status < 200 || response.status >= 300) problem = `answered ${response.status}`;
      } catch (error) {
        problem = (error as Error).name === 'TimeoutError' ? 'timed out' : 'could not connect';
      }
      if (!problem) {
        await this.db.update(merchantEvents).set({ deliveredAt: new Date(), attempts: event.attempts + 1, lastError: null }).where(eq(merchantEvents.id, event.id));
        delivered += 1;
      } else {
        const wait = Math.min(60_000 * 2 ** event.attempts, LONGEST_WAIT_MS);
        await this.db.update(merchantEvents).set({ attempts: event.attempts + 1, nextAttemptAt: new Date(Date.now() + wait), lastError: problem }).where(eq(merchantEvents.id, event.id));
        if (event.attempts + 1 >= MAX_ATTEMPTS) this.logger.warn(`notice ${event.id} gave up: ${problem}`);
      }
    }
    return delivered;
  }

  async reconcile(): Promise<void> {
    await this.queueNotices();
    await this.deliverNotices();
  }
}
