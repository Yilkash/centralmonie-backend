import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
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

  @Get('audit')
  async auditTrail() {
    return { entries: await this.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200) };
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
