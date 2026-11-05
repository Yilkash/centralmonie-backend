/** The parts of a 10kobo payment this agent reads. */
export interface Payment {
  id: string;
  status: string;
  amount: string;
  pay_usdc: string;
  account_name: string;
  account_number: string;
  bank_name: string;
  deposit_address: string | null;
  failure_reason: string | null;
  receipt?: Record<string, unknown>;
}

export interface QuoteRequest {
  amount_naira: number;
  bank_name: string;
  account_number: string;
}

export interface PaymentApi {
  quote(request: QuoteRequest): Promise<Payment>;
  accept(quoteId: string): Promise<Payment>;
  status(id: string): Promise<Payment>;
}

/** A refusal from the API: a stable code an agent can act on, and a sentence. */
export class ApiRefusal extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class TenKoboApi implements PaymentApi {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly payFrom: string;
  private readonly refundTo: string;

  constructor(options: { baseUrl: string; key: string; payFrom: string; refundTo: string }) {
    this.baseUrl = options.baseUrl;
    this.key = options.key;
    this.payFrom = options.payFrom;
    this.refundTo = options.refundTo;
  }

  quote(request: QuoteRequest): Promise<Payment> {
    return this.call('POST', '/v1/agent/quotes', { ...request, pay_from: this.payFrom, refund_to: this.refundTo });
  }

  accept(quoteId: string): Promise<Payment> {
    return this.call('POST', '/v1/agent/payments', { quote_id: quoteId });
  }

  status(id: string): Promise<Payment> {
    return this.call('GET', `/v1/agent/payments/${encodeURIComponent(id)}`);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Payment> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90_000),
    });
    const answer = (await response.json()) as Payment & { code?: string; message?: string };
    if (!response.ok) throw new ApiRefusal(answer.code ?? 'error', answer.message ?? `10kobo answered ${response.status}`);
    return answer;
  }
}
