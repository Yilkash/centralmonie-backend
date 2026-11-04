import { Body, CanActivate, Controller, createParamDecorator, Delete, ExecutionContext, Get, HttpCode, HttpException, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseFilters, UseGuards, Catch, ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { AgentKey, AgentPayment } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { AdminGuard } from '../ops/admin.controller';
import { PAY_FROM, PayFrom } from './cross-chain';
import { AgentApiService, AgentRefusal } from './agent-api.service';

const quoteBody = z.object({
  amount_naira: z.number().int().positive().max(100_000_000),
  bank_name: z.string().trim().min(2).max(80),
  account_number: z.string().regex(/^\d{10}$/, 'An account number has 10 digits.'),
  pay_from: z.enum(Object.keys(PAY_FROM) as [PayFrom, ...PayFrom[]]).default('base'),
  refund_to: z.string().trim().min(2).max(100),
});
const paymentBody = z.object({ quote_id: z.string().uuid() });
const keyBody = z.object({ name: z.string().trim().min(2).max(80), daily_limit_naira: z.number().int().positive() });

const money = (minor: number) => (minor / 1_000_000).toFixed(6);

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
  account_name: payment.accountName,
  ...(payment.status === 'quoted' ? { quote_expires_at: payment.quoteExpiresAt } : {}),
  deposit_address: payment.depositAddress,
  deposit_deadline: payment.depositDeadline,
  transactions: payment.transactions,
  failure_reason: payment.failureReason,
  created_at: payment.createdAt,
  paid_at: payment.paidAt,
  ...(payment.status === 'paid'
    ? {
        receipt: {
          reference: payment.id,
          paid: formatNaira(payment.payoutKobo ?? payment.amountKobo),
          to: `${payment.accountName}, ${payment.bankName} ****${payment.accountNumber.slice(-4)}`,
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

  @Get('payments/:id')
  async get(@CurrentKey() key: AgentKey, @Param('id', ParseUUIDPipe) id: string) {
    return presentPayment(await this.agents.get(key, id));
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
