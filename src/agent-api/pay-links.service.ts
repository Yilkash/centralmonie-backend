import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { AgentPayment, PayLink, payLinks, User } from '../database/schema';
import { BankLookup } from '../providers/providers';
import { AgentApiService, AgentRefusal, maskName } from './agent-api.service';
import { PayFrom } from './cross-chain';

const LINK_LIFETIME_MS = 14 * 24 * 60 * 60_000;
const LINKS_PER_DAY = 20;
const MAX_LINK_NAIRA = 50_000;
/** A payment that has finished without paying the bank, so the link can be tried again. */
const CAN_RETRY = new Set(['refunded', 'expired', 'quoted']);

export interface PayerDetails {
  payFrom: PayFrom;
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
  ) {}

  /** Where the link opens. */
  url(link: PayLink): string {
    const base = this.config.get('PUBLIC_APP_URL', { infer: true }) ?? [this.config.get('CORS_ORIGINS', { infer: true })].flat().join(',').split(',')[0]!.trim();
    return `${base.replace(/\/$/, '')}/pay/${link.id}`;
  }

  /** Makes a link and moves nothing, so this is safe for the chat agent to do. */
  async create(user: User, input: { amountNaira: number; bankName: string; accountNumber: string; note?: string | null }): Promise<PayLink> {
    if (!Number.isInteger(input.amountNaira) || input.amountNaira <= 0) throw new AgentRefusal('invalid_request', 'A pay link needs a whole naira amount.', 400);
    if (input.amountNaira > MAX_LINK_NAIRA) throw new AgentRefusal('over_payment_limit', `The most for one pay link is ₦${MAX_LINK_NAIRA.toLocaleString('en-NG')}.`, 422);
    if (!/^\d{10}$/.test(input.accountNumber)) throw new AgentRefusal('invalid_request', 'A bank account number has 10 digits.', 400);
    const [{ made } = { made: 0 }] = await this.db
      .select({ made: count() })
      .from(payLinks)
      .where(and(eq(payLinks.userId, user.id), gte(payLinks.createdAt, sql`now() - interval '1 day'`)));
    if (made >= LINKS_PER_DAY) throw new AgentRefusal('too_many_requests', 'You have made too many pay links today. Try again tomorrow.', 429);
    const accountName = await this.banks.accountName(input.bankName, input.accountNumber).catch(() => {
      throw new AgentRefusal('bank_unavailable', 'We could not check that account just now. Please try again.', 503);
    });
    if (!accountName) throw new AgentRefusal('account_not_found', 'We could not find that account. Check the bank and the account number.', 404);
    const [link] = await this.db
      .insert(payLinks)
      .values({ userId: user.id, amountKobo: input.amountNaira * 100, bankName: input.bankName, accountNumber: input.accountNumber, accountName, note: input.note?.trim() || null, expiresAt: new Date(Date.now() + LINK_LIFETIME_MS) })
      .returning();
    return link!;
  }

  private async find(id: string): Promise<PayLink> {
    const [link] = await this.db.select().from(payLinks).where(eq(payLinks.id, id));
    if (!link) throw new AgentRefusal('not_found', 'This pay link does not exist.', 404);
    return link;
  }

  /** What a payer sees, with its latest payment. Anyone with the link can read this, so the name is partly hidden. */
  async view(id: string): Promise<{ link: PayLink; payment: AgentPayment | null; open: boolean }> {
    const link = await this.find(id);
    const payment = link.paymentId ? await this.agents.get(await this.agents.keylessKey(), link.paymentId) : null;
    return { link, payment, open: this.agents.keylessOpen && link.expiresAt.getTime() > Date.now() && payment?.status !== 'paid' };
  }

  /** Paying again while a payment is waiting gives that same payment, so a refresh cannot make a second one. */
  async pay(id: string, payer: PayerDetails): Promise<AgentPayment> {
    const { link, payment, open } = await this.view(id);
    if (payment?.status === 'paid') throw new AgentRefusal('already_paid', 'This pay link has been paid.', 409);
    if (!this.agents.keylessOpen) throw new AgentRefusal('unavailable', 'Pay links are not open right now.', 503);
    if (!open) throw new AgentRefusal('link_expired', 'This pay link has expired.', 410);
    if (payment && !CAN_RETRY.has(payment.status)) return payment;
    const key = await this.agents.keylessKey();
    const quote = await this.agents.quote(key, {
      amountNaira: link.amountKobo / 100,
      bankName: link.bankName,
      accountNumber: link.accountNumber,
      payFrom: payer.payFrom,
      refundTo: payer.refundTo,
      payerName: payer.payerName || 'Pay link payer',
      purpose: link.note ?? 'Pay link',
      ...(payer.clientIp ? { clientIp: payer.clientIp } : {}),
    });
    // Claimed before the money route exists, so two people opening one link at once cannot both be given an address.
    const claimed = await this.db
      .update(payLinks)
      .set({ paymentId: quote.id })
      .where(and(eq(payLinks.id, id), link.paymentId ? eq(payLinks.paymentId, link.paymentId) : sql`${payLinks.paymentId} is null`))
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
  expires_at: link.expiresAt,
});

export const presentPublicLink = ({ link, payment, open }: { link: PayLink; payment: AgentPayment | null; open: boolean }) => ({
  id: link.id,
  amount_naira: link.amountKobo / 100,
  to: maskName(link.accountName),
  bank_name: link.bankName,
  account_number: `****${link.accountNumber.slice(-4)}`,
  note: link.note,
  open,
  paid: payment?.status === 'paid',
  payment: payment && {
    id: payment.id,
    status: payment.status,
    pay_from: payment.payFrom,
    pay_usdc: (payment.payInMinor / 1_000_000).toFixed(6),
    deposit_address: payment.status === 'awaiting_deposit' ? payment.depositAddress : null,
    deposit_deadline: payment.status === 'awaiting_deposit' ? payment.depositDeadline : null,
    failure_reason: payment.failureReason,
    paid_at: payment.paidAt,
  },
});
