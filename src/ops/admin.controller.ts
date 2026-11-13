import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Chain } from '../chain/chain.service';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { auditLog, payments, schedules, users } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { NotificationsService } from '../notifications/notifications.service';
import { PinService } from '../pin/pin.service';
import { AuditService } from './audit.service';
import { SWITCH_NAMES, SwitchesService } from './switches.service';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** One shared token for now. Refuses everyone when no token is set. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('ADMIN_TOKEN', { infer: true });
    const header = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>().headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (!expected || scheme !== 'Bearer' || !token || !timingSafeEqual(digest(token), digest(expected))) {
      throw new UnauthorizedException('Not allowed');
    }
    return true;
  }
}

const switchBody = z.object({ name: z.enum(SWITCH_NAMES), paused: z.boolean() });
const resolveBody = z.object({ status: z.enum(['completed', 'returned', 'failed']), note: z.string().trim().min(3).max(500) });
/** Rows from a raw query, whichever shape the driver gives. */
const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? (result as T[]));
/** Account numbers stay masked even here: the back office never needs the full number to help someone. */
const masked = (account: string | null) => (account ? `****${account.slice(-4)}` : null);
/** A search word, made safe for ILIKE. Empty means everything. */
const pattern = (q: unknown) => (typeof q === 'string' && q.trim() ? `%${q.trim().slice(0, 80).replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null);
const LAGOS_DAY = sql.raw(`(now() at time zone 'Africa/Lagos')::date`);

const OPEN = ['awaiting_signature', 'funding', 'funded', 'paying', 'returning', 'needs_support'] as const;

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly switches: SwitchesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly pins: PinService,
    private readonly chain: Chain,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('overview')
  async overview() {
    const open = await this.db.select().from(payments).where(inArray(payments.status, [...OPEN])).orderBy(desc(payments.createdAt)).limit(100);
    const [today] = await this.db
      .select({ count: sql<number>`count(*)::int`, kobo: sql<string>`coalesce(sum(${payments.amountKobo}), 0)` })
      .from(payments)
      .where(sql`${payments.status} = 'completed' and ${payments.createdAt} >= now() - interval '1 day'`);
    const [{ active } = { active: 0 }] = await this.db.select({ active: sql<number>`count(*)::int` }).from(schedules).where(eq(schedules.status, 'active'));
    const [{ people } = { people: 0 }] = await this.db.select({ people: sql<number>`count(*)::int` }).from(users);
    const collection = this.config.get('COLLECTION_ADDRESS', { infer: true });
    const held = collection ? await this.chain.usdcBalance(collection).catch(() => null) : null;
    return {
      mode: this.config.get('PAYMENTS_MODE', { infer: true }),
      switches: await this.switches.all(),
      users: people,
      active_schedules: active,
      last_24h: { payments: today?.count ?? 0, total: formatNaira(Number(today?.kobo ?? 0)) },
      collection_usdc: held === null ? null : formatUsdc(Number(held)),
      open_payments: open.map((payment) => ({
        id: payment.id,
        user_id: payment.userId,
        status: payment.status,
        route: payment.route,
        recipient: payment.recipientName,
        amount: formatNaira(payment.amountKobo),
        usdc: formatUsdc(payment.usdcMinor),
        reason: payment.failureReason,
        funding_tx: payment.fundingTxHash,
        created_at: payment.createdAt,
      })),
    };
  }

  /** Sign-ups and money per day for the last 14 days, in Lagos time, plus the headline numbers. */
  @Get('stats')
  async stats() {
    const days = rowsOf<{ day: string; signups: number; app_paid: number; app_kobo: string; agent_paid: number; agent_kobo: string }>(
      await this.db.execute(sql`
        with days as (select generate_series(${LAGOS_DAY} - 13, ${LAGOS_DAY}, interval '1 day')::date as day)
        select to_char(d.day, 'YYYY-MM-DD') as day,
          (select count(*)::int from users u where (u.created_at at time zone 'Africa/Lagos')::date = d.day) as signups,
          (select count(*)::int from payments p where p.status = 'completed' and (p.created_at at time zone 'Africa/Lagos')::date = d.day) as app_paid,
          (select coalesce(sum(p.amount_kobo), 0)::text from payments p where p.status = 'completed' and (p.created_at at time zone 'Africa/Lagos')::date = d.day) as app_kobo,
          (select count(*)::int from agent_payments a where a.status = 'paid' and (a.paid_at at time zone 'Africa/Lagos')::date = d.day) as agent_paid,
          (select coalesce(sum(coalesce(a.payout_kobo, a.amount_kobo)), 0)::text from agent_payments a where a.status = 'paid' and (a.paid_at at time zone 'Africa/Lagos')::date = d.day) as agent_kobo
        from days d order by d.day`),
    );
    const [totals] = rowsOf<{ users: number; users_7d: number; app_paid: number; app_kobo: string; agent_paid: number; agent_kobo: string; merchants: number; links: number; needs_support: number }>(
      await this.db.execute(sql`select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where created_at >= now() - interval '7 days') as users_7d,
        (select count(*)::int from payments where status = 'completed') as app_paid,
        (select coalesce(sum(amount_kobo), 0)::text from payments where status = 'completed') as app_kobo,
        (select count(*)::int from agent_payments where status = 'paid') as agent_paid,
        (select coalesce(sum(coalesce(payout_kobo, amount_kobo)), 0)::text from agent_payments where status = 'paid') as agent_kobo,
        (select count(*)::int from merchant_keys where revoked_at is null) as merchants,
        (select count(*)::int from product_links where stopped_at is null) as links,
        ((select count(*)::int from payments where status = 'needs_support') + (select count(*)::int from agent_payments where status = 'needs_support')) as needs_support`),
    );
    const t = totals!;
    return {
      totals: {
        users: t.users,
        users_7d: t.users_7d,
        payments_paid: t.app_paid + t.agent_paid,
        volume: formatNaira(Number(t.app_kobo) + Number(t.agent_kobo)),
        merchants: t.merchants,
        payment_links: t.links,
        needs_support: t.needs_support,
      },
      days: days.map((day) => ({ day: day.day, signups: day.signups, payments: day.app_paid + day.agent_paid, volume_naira: (Number(day.app_kobo) + Number(day.agent_kobo)) / 100 })),
    };
  }

  /** Everyone who signed up, newest first, with what they have done. */
  @Get('users')
  async users(@Query('q') q: unknown) {
    const like = pattern(q);
    const rows = rowsOf<{ id: string; email: string | null; wallet_address: string | null; created_at: string; has_pin: boolean; payments: number; sent_kobo: string; last_payment_at: string | null; invoices: number; merchant_keys: number; payment_links: number }>(
      await this.db.execute(sql`select u.id, u.email, u.wallet_address, u.created_at, u.pin_hash is not null as has_pin,
          (select count(*)::int from payments p where p.user_id = u.id) as payments,
          (select coalesce(sum(p.amount_kobo), 0)::text from payments p where p.user_id = u.id and p.status = 'completed') as sent_kobo,
          (select max(p.created_at) from payments p where p.user_id = u.id) as last_payment_at,
          (select count(*)::int from pay_links l where l.user_id = u.id) as invoices,
          (select count(*)::int from merchant_keys k where k.user_id = u.id and k.revoked_at is null) as merchant_keys,
          (select count(*)::int from product_links pl where pl.user_id = u.id) as payment_links
        from users u
        where ${like === null ? sql`true` : sql`(u.email ilike ${like} or u.wallet_address ilike ${like} or u.id::text ilike ${like})`}
        order by u.created_at desc limit 200`),
    );
    return { users: rows.map((row) => ({ ...row, sent: formatNaira(Number(row.sent_kobo)), sent_kobo: undefined })) };
  }

  /** Every kind of payment in one list: sends from the app, and agent, x402, invoice and payment-link payments. */
  @Get('payments')
  async allPayments(@Query('q') q: unknown, @Query('status') status: unknown) {
    const like = pattern(q);
    const wanted = typeof status === 'string' && /^[a-z_]{2,30}$/.test(status) ? status : null;
    const app = rowsOf<{ id: string; status: string; route: string; amount_kobo: string; usdc_minor: string; recipient: string | null; email: string | null; tx: string | null; reason: string | null; created_at: string }>(
      await this.db.execute(sql`select p.id, p.status::text as status, p.route::text as route, p.amount_kobo::text, p.usdc_minor::text, p.recipient_name as recipient, u.email,
          p.funding_tx_hash as tx, p.failure_reason as reason, p.created_at
        from payments p join users u on u.id = p.user_id
        where ${wanted === null ? sql`true` : sql`p.status::text = ${wanted}`}
          and ${like === null ? sql`true` : sql`(p.recipient_name ilike ${like} or u.email ilike ${like} or p.id::text ilike ${like} or p.funding_tx_hash ilike ${like})`}
        order by p.created_at desc limit 200`),
    );
    const agent = rowsOf<{ id: string; status: string; amount_kobo: string; usdc_minor: string; pay_from: string; account_name: string; bank_name: string; account_number: string; payer: string | null; key_name: string; keyless: boolean; source: string | null; tx: string[]; reason: string | null; created_at: string }>(
      await this.db.execute(sql`select a.id, a.status, coalesce(a.payout_kobo, a.amount_kobo)::text as amount_kobo, a.usdc_minor::text, a.pay_from, a.account_name, a.bank_name, a.account_number,
          coalesce(a.payer_name, a.payer_email) as payer, k.name as key_name, k.id = '00000000-0000-4000-8000-000000000402' as keyless,
          (select case when l.merchant_key_id is not null then 'invoice' when l.product_link_id is not null then 'payment_link' else 'pay_link' end from pay_links l where l.payment_id = a.id limit 1) as source,
          a.transactions as tx, a.failure_reason as reason, a.created_at
        from agent_payments a join agent_keys k on k.id = a.key_id
        where a.status not in ('quoted', 'creating')
          and ${wanted === null ? sql`true` : sql`a.status = ${wanted}`}
          and ${like === null ? sql`true` : sql`(a.account_name ilike ${like} or a.payer_name ilike ${like} or a.payer_email ilike ${like} or a.id::text ilike ${like} or a.transactions::text ilike ${like})`}
        order by a.created_at desc limit 200`),
    );
    const list = [
      ...app.map((row) => ({
        id: row.id,
        kind: 'app',
        channel: { bank: 'Bank', airtime: 'Airtime', data: 'Data', usdc: 'Crypto' }[row.route] ?? row.route,
        status: row.status,
        amount: formatNaira(Number(row.amount_kobo)),
        usdc: formatUsdc(Number(row.usdc_minor)),
        to: row.recipient,
        from: row.email,
        tx: row.tx,
        reason: row.reason,
        created_at: row.created_at,
      })),
      ...agent.map((row) => ({
        id: row.id,
        kind: row.source ?? (row.keyless ? 'x402' : 'agent'),
        channel: `From ${row.pay_from}`,
        status: row.status,
        amount: formatNaira(Number(row.amount_kobo)),
        usdc: formatUsdc(Number(row.usdc_minor)),
        to: `${row.account_name}, ${row.bank_name} ${masked(row.account_number)}`,
        from: row.payer ?? row.key_name,
        tx: row.tx?.[row.tx.length - 1] ?? null,
        reason: row.reason,
        created_at: row.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { payments: list.slice(0, 300) };
  }

  /** Shops and sellers: merchant keys, payment links and API keys. */
  @Get('merchants')
  async merchants() {
    const keys = rowsOf<{ id: string; name: string; email: string | null; payout_bank_name: string | null; payout_account_number: string | null; payout_to_wallet: boolean; payout_usdc_address: string | null; payout_near_account: string | null; webhook: boolean; return_origins: string[]; invoices: number; invoices_today: number; paid: number; created_at: string; revoked_at: string | null }>(
      await this.db.execute(sql`select k.id, k.name, u.email, k.payout_bank_name, k.payout_account_number, k.payout_to_wallet, k.payout_usdc_address, k.payout_near_account,
          k.webhook_url is not null as webhook, k.return_origins,
          (select count(*)::int from pay_links l where l.merchant_key_id = k.id) as invoices,
          (select count(*)::int from pay_links l where l.merchant_key_id = k.id and l.created_at >= now() - interval '1 day') as invoices_today,
          (select count(*)::int from pay_links l join agent_payments a on a.id = l.payment_id where l.merchant_key_id = k.id and a.status = 'paid') as paid,
          k.created_at, k.revoked_at
        from merchant_keys k join users u on u.id = k.user_id order by k.created_at desc limit 200`),
    );
    const links = rowsOf<{ id: string; title: string; email: string | null; amount_kobo: string | null; minimum_kobo: string | null; account_name: string; bank_name: string; near_account: string | null; usdc_address: string | null; checkouts: number; paid: number; created_at: string; stopped_at: string | null }>(
      await this.db.execute(sql`select pl.id, pl.title, u.email, pl.amount_kobo::text, pl.minimum_kobo::text, pl.account_name, pl.bank_name, pl.near_account, pl.usdc_address,
          (select count(*)::int from pay_links l where l.product_link_id = pl.id) as checkouts,
          (select count(*)::int from pay_links l join agent_payments a on a.id = l.payment_id where l.product_link_id = pl.id and a.status = 'paid') as paid,
          pl.created_at, pl.stopped_at
        from product_links pl join users u on u.id = pl.user_id order by pl.created_at desc limit 200`),
    );
    const agentKeysList = rowsOf<{ id: string; name: string; daily_limit_kobo: string; payments: number; paid: number; created_at: string; revoked_at: string | null }>(
      await this.db.execute(sql`select k.id, k.name, k.daily_limit_kobo::text,
          (select count(*)::int from agent_payments a where a.key_id = k.id and a.status not in ('quoted', 'creating')) as payments,
          (select count(*)::int from agent_payments a where a.key_id = k.id and a.status = 'paid') as paid,
          k.created_at, k.revoked_at
        from agent_keys k order by k.created_at desc limit 100`),
    );
    const payout = (key: (typeof keys)[number]) =>
      key.payout_to_wallet ? 'CentralMonie wallet' : key.payout_near_account ? `NEAR ${key.payout_near_account}` : key.payout_usdc_address ? `USDC on Base ${key.payout_usdc_address.slice(0, 6)}…${key.payout_usdc_address.slice(-4)}` : `${key.payout_bank_name ?? 'Bank'} ${masked(key.payout_account_number)}`;
    return {
      merchant_keys: keys.map((key) => ({ id: key.id, name: key.name, owner: key.email, payout: payout(key), webhook: key.webhook, websites: key.return_origins, invoices: key.invoices, invoices_today: key.invoices_today, paid: key.paid, created_at: key.created_at, revoked_at: key.revoked_at })),
      payment_links: links.map((link) => ({
        id: link.id,
        title: link.title,
        owner: link.email,
        price: link.amount_kobo ? formatNaira(Number(link.amount_kobo)) : link.minimum_kobo ? `Customer chooses, from ${formatNaira(Number(link.minimum_kobo))}` : 'Customer chooses',
        payout: link.near_account ? `NEAR ${link.near_account}` : link.usdc_address ? 'USDC on Base' : `${link.account_name}, ${link.bank_name}`,
        checkouts: link.checkouts,
        paid: link.paid,
        created_at: link.created_at,
        stopped_at: link.stopped_at,
      })),
      agent_keys: agentKeysList.map((key) => ({ id: key.id, name: key.name, daily_limit: formatNaira(Number(key.daily_limit_kobo)), payments: key.payments, paid: key.paid, created_at: key.created_at, revoked_at: key.revoked_at })),
    };
  }

  @Get('audit')
  async auditTrail() {
    // A person's ID is shown as their email, so staff can see who did what. System actors keep their names.
    const rows = await this.db
      .select({ entry: auditLog, email: users.email })
      .from(auditLog)
      .leftJoin(users, sql`${users.id}::text = ${auditLog.actor}`)
      .orderBy(desc(auditLog.createdAt))
      .limit(200);
    return { entries: rows.map(({ entry, email }) => ({ ...entry, actor_email: email })) };
  }

  @Post('switches')
  @HttpCode(200)
  async setSwitch(@Body() raw: unknown) {
    const parsed = switchBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('A switch name and paused are required');
    await this.switches.set(parsed.data.name, parsed.data.paused);
    await this.audit.record('admin', parsed.data.paused ? 'switch.paused' : 'switch.resumed', parsed.data.name);
    return this.switches.all();
  }

  /** For a payment a person has checked by hand. Only one marked as needing support can change. */
  @Post('payments/:id/resolve')
  @HttpCode(200)
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const parsed = resolveBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('A status and a note are required');
    const [payment] = await this.db
      .update(payments)
      .set({ status: parsed.data.status })
      .where(and(eq(payments.id, id), eq(payments.status, 'needs_support')))
      .returning();
    if (!payment) throw new BadRequestException('Only a payment that needs support can be resolved');
    await this.audit.record('admin', 'payment.resolved', id, parsed.data);
    const name = payment.recipientName ?? 'the recipient';
    const text = { completed: `Your payment to ${name} has been delivered.`, returned: `Your payment to ${name} failed, and the USDC is back in your wallet.`, failed: `Your payment to ${name} did not go through.` }[parsed.data.status];
    await this.notifications.notify(payment.userId, text);
    return { id, status: parsed.data.status };
  }

  @Post('users/:id/reset-pin')
  @HttpCode(200)
  async resetPin(@Param('id', ParseUUIDPipe) id: string) {
    await this.pins.reset(id);
    await this.audit.record('admin', 'pin.reset', id);
    return { id };
  }
}

const INTERNAL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Asked by the web app's gas proxy: is this one of our users' wallets? */
@Controller('v1/internal/sponsorship')
export class SponsorshipController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('wallet')
  @HttpCode(200)
  async wallet(@Body() raw: unknown, @Body('token') token: unknown) {
    const expected = this.config.get('SPONSORSHIP_TOKEN', { infer: true });
    if (!expected || typeof token !== 'string' || !timingSafeEqual(digest(token), digest(expected))) throw new UnauthorizedException('Not allowed');
    const address = (raw as { address?: unknown }).address;
    if (typeof address !== 'string' || !INTERNAL_ADDRESS.test(address)) throw new BadRequestException('An address is required');
    const [row] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.walletAddress}) = ${address.toLowerCase()}`).limit(1);
    return { known: Boolean(row) };
  }
}
