import { Inject, Injectable, Logger } from '@nestjs/common';
import { presentCheck, ProtectService } from '../protect/protect.service';
import { and, count, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, desc } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DATABASE, Database } from '../database/database.module';
import { AgentPayment, agentPayments, MerchantKey, merchantEvents, merchantKeys, PayLink, payLinks, User, users } from '../database/schema';
import { isAddress } from 'viem';
import { isNearAccount } from '../chain/usdc-chains';
import { AgentRefusal, hashKey } from './agent-api.service';
import { AuditService } from '../ops/audit.service';
import { LinkInput, PayLinksService, presentOwnLink } from './pay-links.service';

/** The notices a shop can get. Each is final for its invoice, so each is sent once. */
export type MerchantEventType = 'invoice.paid' | 'invoice.cancelled' | 'invoice.expired';
const STATUS_EVENT: Record<string, MerchantEventType> = { paid: 'invoice.paid', cancelled: 'invoice.cancelled', expired: 'invoice.expired' };
/** About a day of retries: 1, 2, 4 … minutes, then every 6 hours. */
const MAX_ATTEMPTS = 12;
const LONGEST_WAIT_MS = 6 * 60 * 60_000;
const NOTICE_TIMEOUT_MS = 5000;

export interface NewMerchantKey {
  /** Who made it, for the audit log: 'admin' or 'user:<id>'. */
  actor?: string;
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

const production = () => process.env.NODE_ENV === 'production';

/** Addresses no shop's server can be at: this machine, private networks, link-local and cloud metadata, CGNAT. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.)/, '');
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (!ip.includes(':')) return false;
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
}

const privateName = (host: string) => host === 'localhost' || /\.(localhost|local|internal|lan|home|intranet)$/i.test(host) || isPrivateAddress(host);

/**
 * A shop's web address. Plain http and this machine are allowed only outside production, for local testing.
 * In production it must be public https, so a notice can never be aimed at our own network.
 */
function webAddress(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentRefusal('invalid_request', `The ${what} is not a valid web address.`, 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1'].includes(host);
  if (url.username || url.password) throw new AgentRefusal('invalid_request', `The ${what} must not contain a password.`, 400);
  if (production()) {
    if (url.protocol !== 'https:') throw new AgentRefusal('invalid_request', `The ${what} must use https.`, 400);
    if (privateName(host)) throw new AgentRefusal('invalid_request', `The ${what} must be a public website, not a private or internal address.`, 400);
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new AgentRefusal('invalid_request', `The ${what} must use https.`, 400);
  }
  return url;
}

/** Looked up right before sending, so a public name that later points inside our network is still refused. */
async function assertPublicHost(url: URL): Promise<void> {
  if (!production()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (privateName(host)) throw new Error('private address');
  const { lookup } = await import('node:dns/promises');
  const found = await lookup(host, { all: true });
  if (found.length === 0 || found.some((entry) => isPrivateAddress(entry.address))) throw new Error('private address');
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
    private readonly audit: AuditService,
    private readonly protect: ProtectService,
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
    // Who made it and where its money goes, never the key or the secret.
    await this.audit.record(input.actor ?? 'admin', 'merchant_key.created', row!.id, { name: row!.name, userId: owner.id, payout: 'accountNumber' in input.payout ? { bankName: input.payout.bankName, accountNumber: `****${input.payout.accountNumber.slice(-4)}` } : input.payout, returnOrigins: origins, webhook: Boolean(input.webhookUrl) });
    return { id: row!.id, key, webhookSecret };
  }

  /** A person's own keys, newest first. The key itself is never stored, so it is never shown again. */
  async ownKeys(userId: string) {
    const rows = await this.db.select().from(merchantKeys).where(eq(merchantKeys.userId, userId)).orderBy(desc(merchantKeys.createdAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      payout: row.payoutToWallet ? 'Your 10kobo wallet' : row.payoutBankName ? `${row.payoutBankName} ****${(row.payoutAccountNumber ?? '').slice(-4)}` : row.payoutUsdcAddress ? 'A USDC address' : 'A NEAR account',
      return_origins: row.returnOrigins,
      webhook_url: row.webhookUrl,
      invoices_per_day: row.invoicesPerDay,
      created_at: row.createdAt.toISOString(),
      revoked: Boolean(row.revokedAt),
    }));
  }

  /** Only the owner can stop their own key. */
  async revokeOwnKey(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(merchantKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(merchantKeys.id, id), eq(merchantKeys.userId, userId), isNull(merchantKeys.revokedAt)))
      .returning({ id: merchantKeys.id });
    if (rows.length > 0) await this.audit.record(`user:${userId}`, 'merchant_key.revoked', id);
    return rows.length > 0;
  }

  async revokeKey(id: string): Promise<boolean> {
    const rows = await this.db.update(merchantKeys).set({ revokedAt: new Date() }).where(and(eq(merchantKeys.id, id), isNull(merchantKeys.revokedAt))).returning({ id: merchantKeys.id });
    if (rows.length > 0) await this.audit.record('admin', 'merchant_key.revoked', id);
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
    return this.db.transaction(async (tx) => {
      // Held until this invoice is made, so two requests at once are counted one after the other.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'invoices:' + key.id}))`);
      const [{ made } = { made: 0 }] = await tx
        .select({ made: count() })
        .from(payLinks)
        .where(and(eq(payLinks.merchantKeyId, key.id), gte(payLinks.createdAt, sql`now() - interval '1 day'`)));
      if (made >= key.invoicesPerDay) throw new AgentRefusal('too_many_requests', 'This key has made its most invoices for today.', 429);
      return this.makeInvoice(key, owner, input, returnUrl);
    });
  }

  private async makeInvoice(key: MerchantKey, owner: User, input: MerchantInvoiceInput, returnUrl: string | null): Promise<PayLink> {

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
    // A retry may leave details out, but must not change them: a changed order needs a new reference.
    const differs = (given: unknown, kept: unknown) => given !== undefined && given !== null && JSON.stringify(given) !== JSON.stringify(kept);
    // Compared as plain values: the database may keep an item's fields in another order.
    const plain = (list: { description: string; amountNaira: number }[] | null | undefined) => list?.map((item) => `${item.description}|${item.amountNaira}`);
    const items = plain(input.lineItems ?? undefined);
    let returnUrl: string | undefined;
    try {
      returnUrl = input.returnUrl ? new URL(input.returnUrl).toString() : undefined;
    } catch {
      returnUrl = input.returnUrl ?? undefined;
    }
    if (differs(input.note?.trim() || undefined, link.note) || differs(input.dueDate, link.dueDate) || differs(items, plain(link.lineItems)) || differs(returnUrl, link.returnUrl)) {
      throw new AgentRefusal('reference_used', 'That reference already has an invoice with different details. Use a new reference for a changed order.', 409);
    }
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

  /** With 10kobo Protect on, the order's newest check: "pay" ship as normal, "ask" hold and check, "block" do not ship. */
  async present(row: { link: PayLink; payment: AgentPayment | null }) {
    const protect = this.protect.enabled ? presentCheck(await this.protect.latest('merchant_invoice', row.link.id)) : null;
    return { ...presentOwnLink(row, this.links.url(row.link)), reference: row.link.reference, checkout_url: this.links.url(row.link), return_url: row.link.returnUrl, ...(this.protect.enabled ? { protect } : {}) };
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
          // One notice per invoice, except that "paid" is always sent, even after an earlier "expired" or "cancelled".
          sql`not exists (select 1 from ${merchantEvents} where ${merchantEvents.linkId} = ${payLinks.id} and (${merchantEvents.type} = 'invoice.paid' or ${agentPayments.status} is distinct from 'paid'))`,
        ),
      )
      .limit(100);
    let queued = 0;
    for (const row of rows) {
      const invoice = await this.present(row);
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
    // Claimed in one step: due notices are pushed a little into the future, skipping any another copy holds, and only
    // what this copy claimed is sent. A copy that stops mid-send leaves the notice to be tried again after the hold.
    const claimed = await this.db.execute<{ id: string }>(sql`
      update ${merchantEvents} set next_attempt_at = now() + interval '2 minutes'
      where id in (
        select e.id from ${merchantEvents} e join ${merchantKeys} k on k.id = e.key_id
        where e.delivered_at is null and e.next_attempt_at <= now() and e.attempts < ${MAX_ATTEMPTS} and k.revoked_at is null
        order by e.next_attempt_at limit 20 for update of e skip locked
      )
      returning id`);
    const ids = (claimed.rows ?? (claimed as unknown as { id: string }[])).map((row) => row.id);
    if (ids.length === 0) return 0;
    const due = await this.db
      .select({ event: merchantEvents, key: merchantKeys })
      .from(merchantEvents)
      .innerJoin(merchantKeys, eq(merchantEvents.keyId, merchantKeys.id))
      .where(inArray(merchantEvents.id, ids));
    let delivered = 0;
    for (const { event, key } of due) {
      const body = JSON.stringify(event.payload);
      let problem: string | null = null;
      try {
        if (!key.webhookUrl || !key.webhookSecret) throw new Error('no notice address');
        await assertPublicHost(new URL(key.webhookUrl));
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
        problem = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message === 'private address' ? 'refused: not a public address' : 'could not connect';
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
