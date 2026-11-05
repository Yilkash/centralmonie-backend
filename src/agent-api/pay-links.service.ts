import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { isAddress } from 'viem';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { AgentPayment, agentPayments, merchantKeys, PayLink, payLinks, User } from '../database/schema';
import { BankLookup } from '../providers/providers';
import { AgentApiService, AgentRefusal, maskName } from './agent-api.service';
import { addressRefusal } from '../chain/address-check';
import { isNearAccount, USDC_CHAINS } from '../chain/usdc-chains';
import { CrossChain, PayFrom, PayToken } from './cross-chain';

const DAY_MS = 24 * 60 * 60_000;
const LINK_LIFETIME_MS = 14 * DAY_MS;
/** An invoice stays payable this long after its due date, because a late payment is still a payment. */
const AFTER_DUE_MS = 14 * DAY_MS;
const FURTHEST_DUE_MS = 366 * DAY_MS;
const LINKS_PER_DAY = 20;
const MAX_LINK_NAIRA = 50_000;
/** A payment that has finished without paying the bank, so the link can be tried again. */
const CAN_RETRY = new Set(['refunded', 'expired', 'quoted']);
/** The time to send has passed. The old payment is still watched for a late arrival, but its address is no longer offered. */
const lapsed = (payment: AgentPayment | null) => Boolean(payment?.status === 'awaiting_deposit' && payment.depositDeadline && payment.depositDeadline.getTime() <= Date.now());

export interface LinkInput {
  amountNaira?: number | null;
  bankName?: string | null;
  accountNumber?: string | null;
  nearAccount?: string | null;
  /** USDC to this Base address instead of naira to a bank. */
  usdcAddress?: string | null;
  /** USDC to the user's own 10kobo wallet instead of naira to a bank. */
  toMyWallet?: boolean | null;
  note?: string | null;
  dueDate?: string | null;
  lineItems?: { description: string; amountNaira: number }[] | null;
}

/** For an invoice a shop made through the merchant API. The shop's own daily limit applies instead of the user's. */
export interface MerchantLink {
  keyId: string;
  reference: string;
  returnUrl: string | null;
}

export interface PayerDetails {
  payFrom: PayFrom;
  payToken?: PayToken;
  refundTo: string;
  payerName?: string;
  clientIp?: string;
}

/**
 * Lets someone with crypto on any chain pay a user's bank account in naira. It sits on the keyless Agent API,
 * so a payer needs no account, and every limit and switch there applies here too.
 */
@Injectable()
export class PayLinksService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
    private readonly banks: BankLookup,
    private readonly agents: AgentApiService,
    private readonly crossChain: CrossChain,
  ) {}

  /** Where the link opens. */
  url(link: PayLink): string {
    const base = this.config.get('PUBLIC_APP_URL', { infer: true }) ?? [this.config.get('CORS_ORIGINS', { infer: true })].flat().join(',').split(',')[0]!.trim();
    return `${base.replace(/\/$/, '')}/pay/${link.id}`;
  }

  /** Makes a link and moves nothing, so this is safe for the chat agent to do. */
  async create(user: User, input: LinkInput, merchant?: MerchantLink): Promise<PayLink> {
    const items = input.lineItems?.length ? input.lineItems : null;
    const total = items ? items.reduce((sum, item) => sum + item.amountNaira, 0) : null;
    const amountNaira = input.amountNaira ?? total;
    if (!amountNaira || !Number.isInteger(amountNaira) || amountNaira <= 0) throw new AgentRefusal('invalid_request', 'A pay link needs a whole naira amount.', 400);
    if (total !== null && total !== amountNaira) throw new AgentRefusal('invalid_request', `The line items add up to ₦${total.toLocaleString('en-NG')}, not ₦${amountNaira.toLocaleString('en-NG')}.`, 400);
    if (amountNaira > MAX_LINK_NAIRA) throw new AgentRefusal('over_payment_limit', `The most for one pay link is ₦${MAX_LINK_NAIRA.toLocaleString('en-NG')}.`, 422);
    if (input.dueDate && (Number.isNaN(new Date(`${input.dueDate}T23:59:59+01:00`).getTime()) || new Date(`${input.dueDate}T23:59:59+01:00`).getTime() < Date.now())) throw new AgentRefusal('invalid_request', 'The due date has already passed.', 400);
    const dueEnds = input.dueDate ? new Date(`${input.dueDate}T23:59:59+01:00`).getTime() : null;
    if (dueEnds && dueEnds > Date.now() + FURTHEST_DUE_MS) throw new AgentRefusal('invalid_request', 'A due date can be at most a year away.', 400);
    const [{ made } = { made: 0 }] = await this.db
      .select({ made: count() })
      .from(payLinks)
      .where(and(eq(payLinks.userId, user.id), gte(payLinks.createdAt, sql`now() - interval '1 day'`)));
    if (!merchant && made >= LINKS_PER_DAY) throw new AgentRefusal('too_many_requests', 'You have made too many pay links today. Try again tomorrow.', 429);

    if (input.toMyWallet && !user.walletAddress) throw new AgentRefusal('wallet_not_ready', 'Your wallet is still being set up. Please try again in a moment.', 409);
    const usdcAddress = input.nearAccount ? null : input.toMyWallet ? user.walletAddress : input.usdcAddress?.trim() || null;
    let bank: { bankName: string; accountNumber: string; accountName: string };
    if (input.nearAccount) {
      if (!isNearAccount(input.nearAccount)) throw new AgentRefusal('invalid_request', 'That is not a valid NEAR account. It should look like name.near.', 400);
      if (await this.crossChain.nearAccountMissing(input.nearAccount)) throw new AgentRefusal('invalid_request', `The NEAR account ${input.nearAccount} does not exist. Check the spelling.`, 400);
      bank = { bankName: 'NEAR', accountNumber: input.nearAccount, accountName: input.nearAccount };
    } else if (usdcAddress) {
      if (!isAddress(usdcAddress)) throw new AgentRefusal('invalid_request', 'That is not a valid Base address. It should start with 0x and have 42 characters.', 400);
      const problem = addressRefusal(usdcAddress, { usdc: USDC_CHAINS.base.usdc, own: null });
      if (problem) throw new AgentRefusal('invalid_request', problem, 400);
      bank = { bankName: 'Base', accountNumber: usdcAddress, accountName: usdcAddress };
    } else {
      if (!input.bankName || !input.accountNumber) throw new AgentRefusal('invalid_request', 'A pay link needs a bank and account number, or somewhere to receive USDC.', 400);
      if (!/^\d{10}$/.test(input.accountNumber)) throw new AgentRefusal('invalid_request', 'A bank account number has 10 digits.', 400);
      const accountName = await this.banks.accountName(input.bankName, input.accountNumber).catch(() => {
        throw new AgentRefusal('bank_unavailable', 'We could not check that account just now. Please try again.', 503);
      });
      if (!accountName) throw new AgentRefusal('account_not_found', 'We could not find that account. Check the bank and the account number.', 404);
      bank = { bankName: input.bankName, accountNumber: input.accountNumber, accountName };
    }
    const [link] = await this.db
      .insert(payLinks)
      .values({ userId: user.id, amountKobo: amountNaira * 100, ...bank, note: input.note?.trim() || null, dueDate: input.dueDate ?? null, lineItems: items, nearAccount: input.nearAccount ?? null, usdcAddress, merchantKeyId: merchant?.keyId ?? null, reference: merchant?.reference ?? null, returnUrl: merchant?.returnUrl ?? null, expiresAt: new Date(Math.max(Date.now() + LINK_LIFETIME_MS, (dueEnds ?? 0) + AFTER_DUE_MS)) })
      .returning();
    return link!;
  }

  private async find(id: string): Promise<PayLink> {
    const [link] = await this.db.select().from(payLinks).where(eq(payLinks.id, id));
    if (!link) throw new AgentRefusal('not_found', 'This pay link does not exist.', 404);
    return link;
  }

  /** What a payer sees, with its latest payment. Anyone with the link can read this, so the name is partly hidden. */
  async view(id: string): Promise<{ link: PayLink; payment: AgentPayment | null; open: boolean; merchantName: string | null }> {
    const link = await this.find(id);
    const payment = link.paymentId ? await this.agents.get(await this.agents.keylessKey(), link.paymentId) : null;
    const [shop] = link.merchantKeyId ? await this.db.select({ name: merchantKeys.name }).from(merchantKeys).where(eq(merchantKeys.id, link.merchantKeyId)) : [];
    return { link, payment, merchantName: shop?.name ?? null, open: this.agents.keylessOpen && !link.cancelledAt && link.expiresAt.getTime() > Date.now() && payment?.status !== 'paid' };
  }

  /** The user's own links, newest first, each with its latest payment. */
  async list(user: User): Promise<{ link: PayLink; payment: AgentPayment | null }[]> {
    return this.db
      .select({ link: payLinks, payment: agentPayments })
      .from(payLinks)
      .leftJoin(agentPayments, eq(payLinks.paymentId, agentPayments.id))
      .where(eq(payLinks.userId, user.id))
      .orderBy(desc(payLinks.createdAt))
      .limit(200);
  }

  /** Stops a link for good. Refused while someone is part way through paying it, because their money may already be moving. */
  async cancel(user: User, id: string): Promise<PayLink> {
    const [found] = await this.db.select().from(payLinks).where(and(eq(payLinks.id, id), eq(payLinks.userId, user.id)));
    if (!found) throw new AgentRefusal('not_found', 'This invoice does not exist.', 404);
    if (found.cancelledAt) return found;
    const payment = found.paymentId ? await this.agents.get(await this.agents.keylessKey(), found.paymentId) : null;
    if (payment?.status === 'paid') throw new AgentRefusal('already_paid', 'This invoice has been paid, so it cannot be cancelled.', 409);
    if (payment && !CAN_RETRY.has(payment.status) && !lapsed(payment)) throw new AgentRefusal('in_progress', 'Someone is paying this invoice right now, so it cannot be cancelled.', 409);
    // Only if no payment has started since it was read, so a payer cannot slip in between.
    const [cancelled] = await this.db
      .update(payLinks)
      .set({ cancelledAt: new Date() })
      .where(and(eq(payLinks.id, id), isNull(payLinks.cancelledAt), found.paymentId ? eq(payLinks.paymentId, found.paymentId) : isNull(payLinks.paymentId)))
      .returning();
    if (!cancelled) throw new AgentRefusal('in_progress', 'Someone started paying this invoice just now. Please check it again.', 409);
    return cancelled;
  }

  /** Paying again while a payment is waiting gives that same payment, so a refresh cannot make a second one. */
  async pay(id: string, payer: PayerDetails): Promise<AgentPayment> {
    const { link, payment, open } = await this.view(id);
    if (payment?.status === 'paid') throw new AgentRefusal('already_paid', 'This pay link has been paid.', 409);
    if (!this.agents.keylessOpen) throw new AgentRefusal('unavailable', 'Pay links are not open right now.', 503);
    if (link.cancelledAt) throw new AgentRefusal('link_cancelled', 'This invoice was cancelled. Please ask the person who sent it.', 410);
    if (!open) throw new AgentRefusal('link_expired', 'This pay link has expired.', 410);
    if (payment && !CAN_RETRY.has(payment.status) && !lapsed(payment)) return payment;
    const key = await this.agents.keylessKey();
    const quote = await this.agents.quote(key, {
      amountNaira: link.amountKobo / 100,
      bankName: link.bankName,
      accountNumber: link.accountNumber,
      payFrom: payer.payFrom,
      refundTo: payer.refundTo,
      ...(payer.payToken ? { payToken: payer.payToken } : {}),
      ...(link.nearAccount || link.usdcAddress ? { deliverTo: (link.nearAccount ?? link.usdcAddress)! } : {}),
      payerName: payer.payerName || 'Pay link payer',
      purpose: link.note ?? 'Pay link',
      ...(payer.clientIp ? { clientIp: payer.clientIp } : {}),
    });
    // Claimed before the money route exists, so two people opening one link at once cannot both be given an address.
    const claimed = await this.db
      .update(payLinks)
      .set({ paymentId: quote.id })
      .where(and(eq(payLinks.id, id), isNull(payLinks.cancelledAt), link.paymentId ? eq(payLinks.paymentId, link.paymentId) : sql`${payLinks.paymentId} is null`))
      .returning({ id: payLinks.id });
    if (claimed.length === 0) throw new AgentRefusal('in_progress', 'Someone is paying this link right now. Try again in a moment.', 409);
    return this.agents.accept(key, quote.id, payer.clientIp);
  }
}

export const presentLink = (link: PayLink, url: string) => ({
  id: link.id,
  url,
  amount_naira: link.amountKobo / 100,
  bank_name: link.bankName,
  account_number: `****${link.accountNumber.slice(-4)}`,
  account_name: link.accountName,
  note: link.note,
  due_date: link.dueDate,
  line_items: link.lineItems,
  expires_at: link.expiresAt,
});

/** The first NEAR step and the delivery on Base or NEAR, so a payer can check it for themselves. */
function proofLinks(payment: AgentPayment): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const near = payment.transactions.find((hash) => !hash.startsWith('0x') && hash !== 'simulated');
  if (near) links.push({ label: 'NEAR Intents settlement', url: `https://nearblocks.io/txns/${near}` });
  const base = [...payment.transactions].reverse().find((hash) => /^0x[0-9a-f]{64}$/i.test(hash));
  if (base && (!payment.deliverTo || payment.deliverTo.startsWith('0x'))) links.push({ label: 'Delivery on Base', url: `https://basescan.org/tx/${base}` });
  return links;
}

export const presentPublicLink = ({ link, payment, open, merchantName = null }: { link: PayLink; payment: AgentPayment | null; open: boolean; merchantName?: string | null }) => ({
  id: link.id,
  merchant: merchantName,
  return_url: link.returnUrl,
  expires_at: link.expiresAt,
  amount_naira: link.amountKobo / 100,
  to: link.nearAccount ?? link.usdcAddress ?? maskName(link.accountName),
  bank_name: link.bankName,
  account_number: link.nearAccount || link.usdcAddress ? null : `****${link.accountNumber.slice(-4)}`,
  receives: link.nearAccount ? 'USDC on NEAR' : link.usdcAddress ? 'USDC on Base' : 'naira',
  note: link.note,
  due_date: link.dueDate,
  overdue: Boolean(link.dueDate && new Date(`${link.dueDate}T23:59:59+01:00`).getTime() < Date.now()),
  line_items: link.lineItems?.map((item) => ({ description: item.description, amount_naira: item.amountNaira })) ?? null,
  open,
  cancelled: Boolean(link.cancelledAt),
  paid: payment?.status === 'paid',
  payment: payment && {
    id: payment.id,
    status: lapsed(payment) ? 'expired' : payment.status,
    pay_from: payment.payFrom,
    pay_token: payment.payToken,
    pay_usdc: (payment.payInMinor / 1_000_000).toFixed(6),
    receiver_gets_usdc: payment.deliverTo ? (payment.usdcMinor / 1_000_000).toFixed(2) : null,
    deposit_address: payment.status === 'awaiting_deposit' && !lapsed(payment) ? payment.depositAddress : null,
    deposit_deadline: payment.status === 'awaiting_deposit' && !lapsed(payment) ? payment.depositDeadline : null,
    failure_reason: lapsed(payment) ? 'No payment arrived in time.' : payment.failureReason,
    paid_at: payment.paidAt,
    links: proofLinks(payment),
  },
});

export type InvoiceStatus = 'paid' | 'cancelled' | 'expired' | 'being_paid' | 'overdue' | 'unpaid';

/** One line of the user's own list. They made it, so they see the full details. */
export const presentOwnLink = ({ link, payment }: { link: PayLink; payment: AgentPayment | null }, url: string) => {
  const overdue = Boolean(link.dueDate && new Date(`${link.dueDate}T23:59:59+01:00`).getTime() < Date.now());
  const status: InvoiceStatus =
    payment?.status === 'paid'
      ? 'paid'
      : link.cancelledAt
        ? 'cancelled'
        : link.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : payment && !CAN_RETRY.has(payment.status) && !lapsed(payment)
            ? 'being_paid'
            : overdue
              ? 'overdue'
              : 'unpaid';
  return {
    id: link.id,
    url,
    status,
    amount_naira: link.amountKobo / 100,
    note: link.note,
    due_date: link.dueDate,
    line_items: link.lineItems?.map((item) => ({ description: item.description, amount_naira: item.amountNaira })) ?? null,
    to: link.nearAccount ?? link.usdcAddress ?? link.accountName,
    receives: link.nearAccount ? 'USDC on NEAR' : link.usdcAddress ? 'USDC on Base' : `naira, ${link.bankName} ****${link.accountNumber.slice(-4)}`,
    created_at: link.createdAt,
    expires_at: link.expiresAt,
    paid_at: payment?.status === 'paid' ? payment.paidAt : null,
  };
};
