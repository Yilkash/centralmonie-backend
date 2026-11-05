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
  /** Tells the API which transaction paid. Only x402 needs it. */
  deposited?(id: string, txHash: string | null): void;
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

interface Entry {
  amount: string;
  payTo: string;
  extra: { assetTransferMethod?: string; operationToken?: string };
}

/**
 * The same payment over x402. It learns what to pay from the 402 responses, not from 10kobo-specific fields:
 * the amount and deposit address below come from the PAYMENT-REQUIRED header.
 */
export class X402Api implements PaymentApi {
  private readonly plain: TenKoboApi;
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly refundTo: string;
  private readonly tokens = new Map<string, { operationToken: string; depositAddress: string; txHash?: string }>();

  constructor(options: { baseUrl: string; key: string; payFrom: string; refundTo: string }) {
    this.plain = new TenKoboApi(options);
    this.baseUrl = options.baseUrl;
    this.key = options.key;
    this.refundTo = options.refundTo;
  }

  quote(request: QuoteRequest): Promise<Payment> {
    return this.plain.quote(request);
  }

  async accept(quoteId: string): Promise<Payment> {
    const offer = await this.call(quoteId);
    const entry = this.entry(offer.response);
    if (!entry) throw new Error('10kobo did not offer the near-intents payment method.');
    const quoted = await this.call(quoteId, { type: 'quote', refundTo: this.refundTo });
    const details = this.entry(quoted.response);
    if (!details?.payTo || !details.amount || !details.extra.operationToken) throw new Error('The 402 response has no amount or address to pay.');
    this.tokens.set(quoteId, { operationToken: details.extra.operationToken, depositAddress: details.payTo });
    return { ...quoted.body.payment, deposit_address: details.payTo, pay_usdc: (Number(details.amount) / 1_000_000).toFixed(6) };
  }

  deposited(id: string, txHash: string | null): void {
    const token = this.tokens.get(id);
    if (token && txHash) token.txHash = txHash;
  }

  async status(id: string): Promise<Payment> {
    const token = this.tokens.get(id);
    if (!token?.txHash) return this.plain.status(id);
    const { body } = await this.call(id, { type: 'deposit', operationToken: token.operationToken, depositAddress: token.depositAddress, txHash: token.txHash });
    return body.payment;
  }

  private entry(response: Response): Entry | undefined {
    const header = response.headers.get('payment-required');
    if (!header) return undefined;
    const required = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: Entry[] };
    return required.accepts.find((item) => item.extra.assetTransferMethod === 'near-intents');
  }

  private async call(id: string, payload?: object): Promise<{ response: Response; body: { payment: Payment; code?: string; message?: string } }> {
    const url = `${this.baseUrl}/v1/agent/x402/pay/${encodeURIComponent(id)}`;
    const signature = payload && Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, payload })).toString('base64');
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, ...(signature ? { 'payment-signature': signature } : {}) }, signal: AbortSignal.timeout(90_000) });
    const body = (await response.json()) as { payment: Payment; code?: string; message?: string };
    if (body.code) throw new ApiRefusal(body.code, body.message ?? 'Refused');
    return { response, body };
  }
}
