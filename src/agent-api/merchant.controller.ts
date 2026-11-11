import { Body, CanActivate, Controller, createParamDecorator, Delete, ExecutionContext, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { MerchantKey, User } from '../database/schema';
import { AdminGuard } from '../ops/admin.controller';
import { AgentRefusal } from './agent-api.service';
import { AgentRefusalFilter } from './agent-api.controller';
import { MerchantService } from './merchant.service';
import { BankLookup } from '../providers/providers';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

type MerchantRequest = { headers: { authorization?: string }; merchant?: { key: MerchantKey; owner: User } };

@Injectable()
export class MerchantKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    const found = scheme === 'Bearer' && token ? await this.merchants.keyFrom(token) : null;
    if (!found) throw new AgentRefusal('invalid_key', 'That merchant key is not valid.', 401);
    request.merchant = found;
    return true;
  }
}

const Merchant = createParamDecorator((_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<MerchantRequest>().merchant!);

const invalid = (error: z.ZodError) => new AgentRefusal('invalid_request', error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);

const invoiceBody = z
  .object({
    reference: z.string().trim().min(1).max(100),
    amount_naira: z.number().int().positive().optional(),
    note: z.string().trim().max(200).nullish(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    line_items: z.array(z.object({ description: z.string().trim().min(1).max(120), amount_naira: z.number().int().positive() })).max(20).nullish(),
    return_url: z.string().trim().max(500).nullish(),
  })
  .refine((body) => body.amount_naira !== undefined || body.line_items?.length, 'An invoice needs amount_naira or line_items.');

/** For a shop's own server. The key is secret and must never be put in a web page. */
@Controller('v1/merchant/invoices')
@UseFilters(AgentRefusalFilter)
@UseGuards(MerchantKeyGuard)
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @Post()
  @HttpCode(200)
  async create(@Merchant() merchant: { key: MerchantKey; owner: User }, @Body() body: unknown) {
    const parsed = invoiceBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const { reference, amount_naira, note, due_date, line_items, return_url } = parsed.data;
    const link = await this.merchants.createInvoice(merchant.key, merchant.owner, {
      reference,
      amountNaira: amount_naira ?? null,
      note: note ?? null,
      dueDate: due_date ?? null,
      lineItems: line_items?.map((item) => ({ description: item.description, amountNaira: item.amount_naira })) ?? null,
      returnUrl: return_url ?? null,
    });
    return this.merchants.present(await this.merchants.invoice(merchant.key, link.id));
  }

  @Get(':id')
  async get(@Merchant() merchant: { key: MerchantKey }, @Param('id', ParseUUIDPipe) id: string) {
    return this.merchants.present(await this.merchants.invoice(merchant.key, id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Merchant() merchant: { key: MerchantKey; owner: User }, @Param('id', ParseUUIDPipe) id: string) {
    await this.merchants.cancel(merchant.key, merchant.owner, id);
    return this.merchants.present(await this.merchants.invoice(merchant.key, id));
  }
}

const keyBody = z.object({
  user_email: z.string().email(),
  name: z.string().trim().min(2).max(60),
  payout: z.union([
    z.object({ bank_name: z.string().trim().min(2), account_number: z.string().regex(/^\d{10}$/) }),
    z.object({ to_my_wallet: z.literal(true) }),
    z.object({ usdc_address: z.string().trim().max(42) }),
    z.object({ near_account: z.string().trim().min(2).max(70) }),
  ]),
  return_origins: z.array(z.string()).max(10).optional(),
  webhook_url: z.string().max(500).nullish(),
  invoices_per_day: z.number().int().positive().max(5000).optional(),
});

/** Keys are made by hand for shops we approve. */
@Controller('v1/admin/merchant-keys')
@UseFilters(AgentRefusalFilter)
@UseGuards(AdminGuard)
export class MerchantKeysController {
  constructor(private readonly merchants: MerchantService) {}

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown) {
    const parsed = keyBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const { user_email, name, payout, return_origins, webhook_url, invoices_per_day } = parsed.data;
    const made = await this.merchants.createKey({
      userEmail: user_email,
      name,
      payout:
        'to_my_wallet' in payout
          ? { toMyWallet: true }
          : 'usdc_address' in payout
            ? { usdcAddress: payout.usdc_address }
            : 'near_account' in payout
              ? { nearAccount: payout.near_account }
              : { bankName: payout.bank_name, accountNumber: payout.account_number },
      returnOrigins: return_origins ?? [],
      webhookUrl: webhook_url ?? null,
      ...(invoices_per_day ? { invoicesPerDay: invoices_per_day } : {}),
    });
    return { id: made.id, key: made.key, webhook_secret: made.webhookSecret };
  }

  @Delete(':id')
  @HttpCode(200)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.merchants.revokeKey(id))) throw new NotFoundException('No such key.');
    return { revoked: true };
  }
}

const ownKeyBody = z.object({
  name: z.string().trim().min(2).max(60),
  // Self-serve keys pay only the person who made them: their own wallet, or a bank account they name.
  // The owner chooses where the money goes: their 10kobo wallet, a bank account, USDC on Base or a NEAR account.
  payout: z.union([
    z.object({ to_my_wallet: z.literal(true) }),
    z.object({ bank_name: z.string().trim().min(2).max(60), account_number: z.string().regex(/^\d{10}$/) }),
    z.object({ usdc_address: z.string().trim().max(42) }),
    z.object({ near_account: z.string().trim().min(2).max(70) }),
  ]),
  return_origins: z.array(z.string().max(200)).max(5).optional(),
  webhook_url: z.string().max(500).nullish(),
});

/** At most this many live keys per person, and a lower daily limit than keys we make by hand. */
const OWN_KEYS_LIMIT = 3;
const OWN_KEY_INVOICES_PER_DAY = 50;

/** A signed-in person makes, lists and stops their own merchant keys, with no one at 10kobo in the way. */
@Controller('v1/merchant-keys')
@UseFilters(AgentRefusalFilter)
@UseGuards(AuthGuard)
export class OwnMerchantKeysController {
  constructor(
    private readonly merchants: MerchantService,
    private readonly banks: BankLookup,
  ) {}

  /** The bank's name for an account, so the owner sees who will be paid before making a key. Moves nothing. */
  /** In memory, so a restart clears it. Stops one account being used to look up many names. */
  private readonly checks = new Map<string, { until: number; count: number }>();

  @Post('check-account')
  @HttpCode(200)
  async checkAccount(@CurrentUser() user: User, @Body() body: unknown) {
    const now = Date.now();
    const window = this.checks.get(user.id);
    const current = window && window.until > now ? window : { until: now + 3_600_000, count: 0 };
    current.count += 1;
    this.checks.set(user.id, current);
    if (this.checks.size > 10_000) for (const [id, entry] of this.checks) if (entry.until <= now) this.checks.delete(id);
    if (current.count > 20) throw new AgentRefusal('too_many_requests', 'Too many account checks. Try again later.', 429);
    const parsed = z.object({ bank_name: z.string().trim().min(2).max(60), account_number: z.string().regex(/^\d{10}$/) }).safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const name = await this.banks.accountName(parsed.data.bank_name, parsed.data.account_number);
    if (!name) throw new AgentRefusal('account_not_found', 'That bank has no account with that number. Check both and try again.', 422);
    return { account_name: name };
  }

  @Get()
  async list(@CurrentUser() user: User) {
    return { keys: await this.merchants.ownKeys(user.id) };
  }

  @Post()
  @HttpCode(200)
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = ownKeyBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    if (!user.email) throw new AgentRefusal('invalid_request', 'Your account needs an email before it can have a merchant key.', 400);
    const live = (await this.merchants.ownKeys(user.id)).filter((key) => !key.revoked).length;
    if (live >= OWN_KEYS_LIMIT) throw new AgentRefusal('too_many_requests', `You can have ${OWN_KEYS_LIMIT} keys at a time. Stop one you no longer use first.`, 429);
    const { name, payout, return_origins, webhook_url } = parsed.data;
    // A typo in an account number would send every order to a stranger, so the account must exist first.
    if ('bank_name' in payout && !(await this.banks.accountName(payout.bank_name, payout.account_number))) {
      throw new AgentRefusal('account_not_found', 'That bank has no account with that number. Check both and try again.', 422);
    }
    const made = await this.merchants.createKey({
      actor: `user:${user.id}`,
      userEmail: user.email,
      name,
      payout:
        'to_my_wallet' in payout
          ? { toMyWallet: true }
          : 'usdc_address' in payout
            ? { usdcAddress: payout.usdc_address }
            : 'near_account' in payout
              ? { nearAccount: payout.near_account }
              : { bankName: payout.bank_name, accountNumber: payout.account_number },
      returnOrigins: return_origins ?? [],
      webhookUrl: webhook_url ?? null,
      invoicesPerDay: OWN_KEY_INVOICES_PER_DAY,
    });
    // Shown this once only. We keep a hash, so it cannot be shown again.
    return { id: made.id, key: made.key, webhook_secret: made.webhookSecret };
  }

  @Delete(':id')
  @HttpCode(200)
  async revoke(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.merchants.revokeOwnKey(user.id, id))) throw new NotFoundException('No such key.');
    return { revoked: true };
  }
}
