/** Talks to the 10kobo x402 endpoints. It holds no wallet and no money: the agent sends the USDC itself. */
export interface ClientOptions {
  baseUrl: string;
  key?: string | undefined;
  fetchFn?: typeof fetch;
}

export class TenKoboError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Entry {
  amount: string;
  network: string;
  payTo: string;
  extra: { assetTransferMethod?: string; refundDeadline?: string; operationToken?: string };
}

export class TenKoboClient {
  private readonly baseUrl: string;
  private readonly key: string | undefined;
  private readonly fetchFn: typeof fetch;
  /** The refund address and token for each payment. Kept out of what the model sees. */
  private readonly payments = new Map<string, { refundTo: string; token?: string; address?: string }>();

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.key = options.key;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async quote(input: Record<string, unknown> & { refund_to: string }): Promise<Record<string, unknown>> {
    const { body } = await this.call('/v1/agent/x402/pay', input);
    const payment = body.payment as { id: string };
    this.payments.set(payment.id, { refundTo: input.refund_to });
    return payment;
  }

  async accept(id: string): Promise<{ pay_exact_usdc: string; to_address: string; network: string; send_before: string | undefined; payment_id: string }> {
    const known = this.payments.get(id);
    if (!known) throw new TenKoboError('not_found', 'Get a quote first. That quote is not from this session.');
    const url = this.resource(id);
    const { response } = await this.call(`/v1/agent/x402/pay/${id}`, undefined, { x402Version: 2, resource: { url }, payload: { type: 'quote', refundTo: known.refundTo } });
    const header = response.headers.get('payment-required');
    if (!header) throw new TenKoboError('not_payable', 'This payment can no longer be paid. Check its status.');
    const required = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: Entry[] };
    const entry = required.accepts.find((item) => item.extra.assetTransferMethod === 'near-intents');
    if (!entry?.payTo || !entry.amount) throw new TenKoboError('not_payable', 'This payment can no longer be paid. Check its status.');
    known.token = entry.extra.operationToken ?? '';
    known.address = entry.payTo;
    return { payment_id: id, pay_exact_usdc: (Number(entry.amount) / 1_000_000).toFixed(6), to_address: entry.payTo, network: entry.network, send_before: entry.extra.refundDeadline };
  }

  async status(id: string, txHash?: string): Promise<Record<string, unknown>> {
    const known = this.payments.get(id);
    const signature = txHash && known?.token && known.address ? { x402Version: 2, resource: { url: this.resource(id) }, payload: { type: 'deposit', operationToken: known.token, depositAddress: known.address, txHash } } : undefined;
    const { body } = await this.call(`/v1/agent/x402/pay/${id}`, undefined, signature);
    return { payment: body.payment, ...(body.settlement ? { settlement: body.settlement } : {}) };
  }

  private resource(id: string): string {
    return `${this.baseUrl}/v1/agent/x402/pay/${id}`;
  }

  private async call(path: string, json?: unknown, signature?: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
        ...(signature ? { 'payment-signature': Buffer.from(JSON.stringify(signature)).toString('base64') } : {}),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.code === 'string') throw new TenKoboError(body.code, String(body.message ?? 'Refused'));
    return { response, body };
  }
}
