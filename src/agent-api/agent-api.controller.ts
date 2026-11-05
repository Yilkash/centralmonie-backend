import { Body, CanActivate, Controller, createParamDecorator, Delete, ExecutionContext, Get, Header, Headers, HttpCode, HttpException, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseFilters, UseGuards, Catch, ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AgentKey, AgentPayment, User } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { AdminGuard } from '../ops/admin.controller';
import { PAY_FROM, PayFrom } from './cross-chain';
import { AgentApiService, AgentRefusal, KEYLESS_KEY_ID, maskName } from './agent-api.service';
import { PayLinksService, presentLink, presentOwnLink, presentPublicLink } from './pay-links.service';
import { decodeSignature, encode, firstChallenge, provesPayment, quotedChallenge, settlement, tokenProblem } from './x402';

const quoteBody = z.object({
  amount_naira: z.number().int().positive().max(100_000_000),
  bank_name: z.string().trim().min(2).max(80),
  account_number: z.string().regex(/^\d{10}$/, 'An account number has 10 digits.'),
  pay_from: z.enum(Object.keys(PAY_FROM) as [PayFrom, ...PayFrom[]]).default('base'),
  refund_to: z.string().trim().min(2).max(100),
});
const paymentBody = z.object({ quote_id: z.string().uuid() });
const relayBody = z.object({ signed_delegate: z.string().min(10).max(8000) });
/** What a keyless agent must tell us. It can be false, so it is a record for follow-up and never a safety check. */
const keylessFields = z.object({ payer_name: z.string().trim().min(2).max(120), payer_email: z.string().trim().email().max(160), purpose: z.string().trim().min(3).max(300) });
const keyBody = z.object({ name: z.string().trim().min(2).max(80), daily_limit_naira: z.number().int().positive() });

const money = (minor: number) => (minor / 1_000_000).toFixed(6);

/** The bank's name for an account goes in full only to a key we issued. */
const shownName = (payment: AgentPayment) => (payment.keyId === KEYLESS_KEY_ID ? maskName(payment.accountName) : payment.accountName);

export const presentPayment = (payment: AgentPayment) => ({
  id: payment.id,
  status: payment.status,
  amount_naira: (payment.payoutKobo ?? payment.amountKobo) / 100,
  amount: formatNaira(payment.payoutKobo ?? payment.amountKobo),
  usdc_delivered: money(payment.usdcMinor),
  pay_usdc: money(payment.payInMinor),
  pay_from: payment.payFrom,
  bank_name: payment.bankName,
  account_number: `****${payment.accountNumber.slice(-4)}`,
  account_name: shownName(payment),
  ...(payment.status === 'quoted' ? { quote_expires_at: payment.quoteExpiresAt } : {}),
  // Only while it can still be paid. A finished or expired payment must never look payable.
  deposit_address: payment.status === 'awaiting_deposit' ? payment.depositAddress : null,
  deposit_deadline: payment.status === 'awaiting_deposit' ? payment.depositDeadline : null,
  transactions: payment.transactions,
  failure_reason: payment.failureReason,
  created_at: payment.createdAt,
  paid_at: payment.paidAt,
  ...(payment.status === 'paid'
    ? {
        receipt: {
          reference: payment.id,
          paid: formatNaira(payment.payoutKobo ?? payment.amountKobo),
          to: `${shownName(payment)}, ${payment.bankName} ****${payment.accountNumber.slice(-4)}`,
          funded_with: formatUsdc(payment.usdcMinor),
          paid_at: payment.paidAt,
          transactions: payment.transactions,
        },
      }
    : {}),
});

const invalid = (error: z.ZodError) => new AgentRefusal('invalid_request', error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);

@Catch(AgentRefusal)
class AgentRefusalFilter implements ExceptionFilter {
  catch(refusal: AgentRefusal, host: ArgumentsHost) {
    host.switchToHttp().getResponse<{ status(code: number): { send(body: unknown): void } }>().status(refusal.httpStatus).send({ code: refusal.code, message: refusal.message });
  }
}

const CurrentKey = createParamDecorator((_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<{ agentKey: AgentKey }>().agentKey);

@Injectable()
export class AgentKeyGuard implements CanActivate {
  constructor(private readonly agents: AgentApiService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.agents.open) throw new AgentRefusal('unavailable', 'The Agent API is not open.', 503);
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; agentKey?: AgentKey }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    const key = scheme === 'Bearer' && token ? await this.agents.keyFrom(token) : null;
    if (!key) throw new AgentRefusal('invalid_key', 'That API key is not valid.', 401);
    request.agentKey = key;
    return true;
  }
}

/** With a key, that key's limits. With no key, the shared keyless limits, if keyless paying is open. */
@Injectable()
export class X402Guard implements CanActivate {
  constructor(private readonly agents: AgentApiService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.agents.open) throw new AgentRefusal('unavailable', 'The Agent API is not open.', 503);
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; agentKey?: AgentKey }>();
    if (request.headers.authorization) {
      const [scheme, token] = request.headers.authorization.split(' ');
      const key = scheme === 'Bearer' && token ? await this.agents.keyFrom(token) : null;
      if (!key) throw new AgentRefusal('invalid_key', 'That API key is not valid.', 401);
      request.agentKey = key;
      return true;
    }
    if (!this.agents.keylessOpen) throw new AgentRefusal('key_required', 'An API key is required.', 401);
    request.agentKey = await this.agents.keylessKey();
    return true;
  }
}

@Controller('v1/agent')
@UseFilters(AgentRefusalFilter)
@UseGuards(AgentKeyGuard)
export class AgentApiController {
  constructor(private readonly agents: AgentApiService) {}

  /** The price and the bank's name for the account. Moves nothing. */
  @Post('quotes')
  @HttpCode(200)
  async quote(@CurrentKey() key: AgentKey, @Body() body: unknown) {
    const parsed = quoteBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const { amount_naira, bank_name, account_number, pay_from, refund_to } = parsed.data;
    return presentPayment(await this.agents.quote(key, { amountNaira: amount_naira, bankName: bank_name, accountNumber: account_number, payFrom: pay_from, refundTo: refund_to }));
  }

  /** Accepts a quote and returns where to send the USDC. Safe to repeat. */
  @Post('payments')
  @HttpCode(200)
  async pay(@CurrentKey() key: AgentKey, @Body() body: unknown) {
    const parsed = paymentBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    return presentPayment(await this.agents.accept(key, parsed.data.quote_id));
  }

  @Get('payments.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async csv(@CurrentKey() key: AgentKey) {
    return this.agents.paymentsCsv(key);
  }

  @Get('payments/:id')
  async get(@CurrentKey() key: AgentKey, @Param('id', ParseUUIDPipe) id: string) {
    return presentPayment(await this.agents.get(key, id));
  }
}

interface X402Reply {
  status(code: number): X402Reply;
  header(name: string, value: string): X402Reply;
}

/**
 * The same payment, for an agent that speaks x402. No PAYMENT-SIGNATURE: says what is on offer. A quote
 * payload: accepts the quote and says where to pay. A deposit payload: reports where the money is.
 */
@Controller('v1/agent/x402')
@UseFilters(AgentRefusalFilter)
@UseGuards(X402Guard)
export class AgentX402Controller {
  constructor(private readonly agents: AgentApiService) {}

  /** Pays the gas for a signed USDC transfer from NEAR, so an agent needs no NEAR. Safe to refuse: nothing moves unless it passes. */
  @Post('pay/:id/relay')
  @HttpCode(200)
  async relay(@CurrentKey() key: AgentKey, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = relayBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    return presentPayment(await this.agents.relay(key, id, parsed.data.signed_delegate));
  }

  /** Starts a payment and answers with the first 402, so an agent needs nothing from us beforehand. */
  @Post('pay')
  @HttpCode(200)
  async start(
    @CurrentKey() key: AgentKey,
    @Body() body: unknown,
    @Req() request: { protocol: string; hostname: string; ip: string },
    @Res({ passthrough: true }) reply: X402Reply,
  ) {
    const parsed = quoteBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const payer = keylessFields.safeParse(body);
    if (key.id === KEYLESS_KEY_ID && !payer.success) throw invalid(payer.error);
    const { amount_naira, bank_name, account_number, pay_from, refund_to } = parsed.data;
    const payment = await this.agents.quote(key, {
      amountNaira: amount_naira,
      bankName: bank_name,
      accountNumber: account_number,
      payFrom: pay_from,
      refundTo: refund_to,
      clientIp: request.ip,
      ...(payer.success ? { payerName: payer.data.payer_name, payerEmail: payer.data.payer_email, purpose: payer.data.purpose } : {}),
    });
    const offer = firstChallenge(payment, `${request.protocol}://${request.hostname}/v1/agent/x402/pay/${payment.id}`);
    reply.status(402).header('PAYMENT-REQUIRED', encode(offer));
    return { ...offer, payment: presentPayment(payment) };
  }

  @Post('pay/:id')
  @HttpCode(200)
  async pay(
    @CurrentKey() key: AgentKey,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('payment-signature') signature: string | undefined,
    @Req() request: { protocol: string; hostname: string; ip: string },
    @Res({ passthrough: true }) reply: X402Reply,
  ) {
    const path = `/v1/agent/x402/pay/${id}`;
    const url = `${request.protocol}://${request.hostname}${path}`;
    const challenge = (body: { x402Version: number }, payment: AgentPayment) => {
      reply.status(402).header('PAYMENT-REQUIRED', encode(body));
      return { ...body, payment: presentPayment(payment) };
    };

    if (!signature) {
      const current = await this.agents.get(key, id);
      return challenge(firstChallenge(current, url), current);
    }

    const signed = decodeSignature(signature);
    if (!signed) throw new AgentRefusal('invalid_request', 'PAYMENT-SIGNATURE is not a valid x402 payload.', 400);
    let resourcePath: string | null = null;
    try {
      resourcePath = new URL(signed.resource.url).pathname;
    } catch {
      resourcePath = null;
    }
    if (resourcePath !== path) throw new AgentRefusal('invalid_request', 'The payload is for a different resource.', 400);

    if (signed.payload.type === 'quote') {
      const current = await this.agents.get(key, id);
      if (signed.payload.refundTo !== current.refundTo) throw new AgentRefusal('invalid_refund_address', 'refundTo must be the refund address given in the quote.', 400);
      const accepted = await this.agents.accept(key, id, request.ip);
      // Asked again after it finished or expired: say what happened, and never offer an address to pay.
      if (accepted.status !== 'awaiting_deposit') {
        const result = settlement(accepted, '');
        reply.header('PAYMENT-RESPONSE', encode(result));
        if (!result.success) reply.status(402);
        return { settlement: result, payment: presentPayment(accepted) };
      }
      return challenge(quotedChallenge(key.keyHash, accepted, url, path), accepted);
    }

    const before = await this.agents.get(key, id);
    if (!before.depositAddress || signed.payload.depositAddress !== before.depositAddress) throw new AgentRefusal('invalid_exact_near_intents_token_invalid', 'That is not the deposit address for this payment.', 402);
    const problem = tokenProblem(key.keyHash, before, path, signed.payload.operationToken);
    if (problem) throw new AgentRefusal(problem, 'That operation token is not valid for this payment.', 402);
    if (!provesPayment(before, signed.payload.txHash)) throw new AgentRefusal('invalid_exact_near_intents_deposit_not_found', 'That transaction did not pay this deposit address.', 402);

    const result = settlement(before, signed.payload.txHash);
    reply.header('PAYMENT-RESPONSE', encode(result));
    if (!result.success) reply.status(402);
    return { settlement: result, payment: presentPayment(before) };
  }
}

@Controller('v1/admin/agent-keys')
@UseGuards(AdminGuard)
export class AgentKeysController {
  constructor(private readonly agents: AgentApiService) {}

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown) {
    const parsed = keyBody.safeParse(body);
    if (!parsed.success) throw new HttpException('A key needs a name and a daily limit.', 400);
    return this.agents.createKey(parsed.data.name, parsed.data.daily_limit_naira);
  }

  @Delete(':id')
  @HttpCode(200)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.agents.revokeKey(id))) throw new NotFoundException('No such key.');
    return { revoked: true };
  }
}

const payLinkBody = z.object({
  amount_naira: z.number().int().positive().optional(),
  bank_name: z.string().trim().min(2).max(80).nullish(),
  account_number: z.string().regex(/^\d{10}$/).nullish(),
  near_account: z.string().trim().min(2).max(70).nullish(),
  usdc_address: z.string().trim().max(42).nullish(),
  to_my_wallet: z.boolean().nullish(),
  note: z.string().trim().max(200).nullish(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  line_items: z.array(z.object({ description: z.string().trim().min(1).max(120), amount_naira: z.number().int().positive() })).max(20).nullish(),
});
const payerBody = z.object({ pay_from: z.enum(Object.keys(PAY_FROM) as [PayFrom, ...PayFrom[]]), pay_token: z.enum(['USDC', 'USDT']).default('USDC'), refund_to: z.string().trim().min(2).max(100), payer_name: z.string().trim().max(120).nullish() });

@Controller('v1/pay-links')
@UseFilters(AgentRefusalFilter)
@UseGuards(AuthGuard)
export class PayLinksController {
  constructor(private readonly links: PayLinksService) {}

  @Post()
  @HttpCode(200)
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = payLinkBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const { amount_naira, bank_name, account_number, near_account, usdc_address, to_my_wallet, note, due_date, line_items } = parsed.data;
    const link = await this.links.create(user, { amountNaira: amount_naira ?? null, bankName: bank_name ?? null, accountNumber: account_number ?? null, nearAccount: near_account ?? null, usdcAddress: usdc_address ?? null, toMyWallet: to_my_wallet ?? null, note: note ?? null, dueDate: due_date ?? null, lineItems: line_items?.map((item) => ({ description: item.description, amountNaira: item.amount_naira })) ?? null });
    return presentLink(link, this.links.url(link));
  }

  @Get()
  async list(@CurrentUser() user: User) {
    return { invoices: (await this.links.list(user)).map((row) => presentOwnLink(row, this.links.url(row.link))) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const link = await this.links.cancel(user, id);
    return presentOwnLink({ link, payment: null }, this.links.url(link));
  }
}

/** For whoever opens a link. No sign-in, so they see only what they need to pay. */
@Controller('v1/public/pay-links')
@UseFilters(AgentRefusalFilter)
export class PublicPayLinksController {
  constructor(private readonly links: PayLinksService) {}

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return presentPublicLink(await this.links.view(id));
  }

  @Post(':id/pay')
  @HttpCode(200)
  async pay(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() request: { ip: string }) {
    const parsed = payerBody.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    await this.links.pay(id, { payFrom: parsed.data.pay_from, payToken: parsed.data.pay_token, refundTo: parsed.data.refund_to, clientIp: request.ip, ...(parsed.data.payer_name ? { payerName: parsed.data.payer_name } : {}) });
    return presentPublicLink(await this.links.view(id));
  }
}
