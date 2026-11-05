import { Body, CanActivate, Controller, createParamDecorator, Delete, ExecutionContext, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { MerchantKey, User } from '../database/schema';
import { AdminGuard } from '../ops/admin.controller';
import { AgentRefusal } from './agent-api.service';
import { AgentRefusalFilter } from './agent-api.controller';
import { MerchantService } from './merchant.service';

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
  payout: z.union([z.object({ bank_name: z.string().trim().min(2), account_number: z.string().regex(/^\d{10}$/) }), z.object({ to_my_wallet: z.literal(true) })]),
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
      payout: 'to_my_wallet' in payout ? { toMyWallet: true } : { bankName: payout.bank_name, accountNumber: payout.account_number },
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
