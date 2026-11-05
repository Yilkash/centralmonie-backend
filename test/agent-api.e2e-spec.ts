import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AgentApiService, agentApiOpen, ipGroup, KEYLESS_KEY_ID, maskName, paymentsToCsv, validRefundAddress } from '../src/agent-api/agent-api.service';
import { NearRelayer, SignedDelegate, USDC_ON_NEAR } from '../src/agent-api/near-relay';
import { PayLinksService, presentOwnLink } from '../src/agent-api/pay-links.service';
import { MerchantService, signNotice } from '../src/agent-api/merchant.service';
import { operationToken, tokenProblem } from '../src/agent-api/x402';
import { AgentPayment, User } from '../src/database/schema';
import { CrossChain, CrossChainRequest, CrossChainState } from '../src/agent-api/cross-chain';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import { SwitchesService } from '../src/ops/switches.service';
import { WalletService } from '../src/wallet/wallet.service';
import { AgentPayout, BankLookup, ExchangeRates, PaymentProvider, PaymentRequest, PaymentState } from '../src/providers/providers';

const DATABASE_URL = process.env.DATABASE_URL!;
const REFUND = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';
const REQUEST = { amount_naira: 5000, bank_name: 'OPay', account_number: '8031234568', pay_from: 'near', refund_to: 'agent.near' };

class FakeCrossChain extends CrossChain {
  state: CrossChainState = { status: 'waiting', transactions: [] };
  quotes: CrossChainRequest[] = [];
  failNext = 0;
  missingNear = new Set<string>();
  override async nearAccountMissing(account: string) {
    return this.missingNear.has(account);
  }
  async priceCheck(request: CrossChainRequest) {
    return { depositAddress: null, payInMinor: request.usdcMinor + 2_400 };
  }
  async quote(request: CrossChainRequest) {
    if (this.failNext-- > 0) throw new Error('secret detail from the partner');
    this.quotes.push(request);
    return { depositAddress: '0xdeposit', payInMinor: request.usdcMinor + 2_400 };
  }
  async sendFromBase(request: { usdcMinor: number; dry: boolean }) {
    return { depositAddress: request.dry ? null : '0xnear', receiverMinor: request.usdcMinor - 1000, seconds: 30 };
  }
  async status() {
    return this.state;
  }
}

class FakePayout extends AgentPayout {
  deposits: PaymentRequest[] = [];
  state: PaymentState = { state: 'pending' };
  destinationKobo: number | null = null;
  expiresAt: string | null = null;
  async deposit(request: PaymentRequest) {
    this.deposits.push(request);
    return { address: '0xswitch', usdcMinor: request.usdcMinor, destinationKobo: this.destinationKobo ?? request.amountKobo, expiresAt: this.expiresAt };
  }
  async status() {
    return this.state;
  }
}

class FakeBanks extends BankLookup {
  down = false;
  async accountName(_bank: string, accountNumber: string) {
    if (this.down) throw new Error('bank down');
    return accountNumber.endsWith('0000') ? null : 'Ada Bello';
  }
}

class FakeRelayer extends NearRelayer {
  sent: string[] = [];
  registered: string[] = [];
  delegate: SignedDelegate | null = null;
  failSend = false;
  decode() {
    if (!this.delegate) throw new Error('unreadable');
    return this.delegate;
  }
  async ensureRegistered(account: string) {
    this.registered.push(account);
  }
  async send(signed: string) {
    if (this.failSend) throw new Error('rpc down');
    this.sent.push(signed);
    return '0xrelayed';
  }
}

describe('Agent API', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let agents: AgentApiService;
  const crossChain = new FakeCrossChain();
  const payout = new FakePayout();
  const banks = new FakeBanks();
  const relayer = new FakeRelayer();
  let key: string;

  const call = (method: 'GET' | 'POST', url: string, body?: object, token: string | null = key) =>
    app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(body ? { payload: body } : {}) });
  const quote = async (over: object = {}) => (await call('POST', '/v1/agent/quotes', { ...REQUEST, ...over })).json();
  const accepted = async (over: object = {}) => (await call('POST', '/v1/agent/payments', { quote_id: (await quote(over)).id })).json();
  const status = async (id: string) => (await call('GET', `/v1/agent/payments/${id}`)).json();

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CrossChain).useValue(crossChain)
      .overrideProvider(AgentPayout).useValue(payout)
      .overrideProvider(BankLookup).useValue(banks)
      .overrideProvider(NearRelayer).useValue(relayer)
      .overrideProvider(ExchangeRates).useValue({ nairaPerUsdc: async () => 1400 })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    agents = app.get(AgentApiService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE agent_keys CASCADE');
    (agents as unknown as { ipWindows: Map<string, unknown> }).ipWindows.clear();
    crossChain.state = { status: 'waiting', transactions: [] };
    crossChain.quotes = [];
    crossChain.failNext = 0;
    payout.deposits = [];
    payout.state = { state: 'pending' };
    payout.destinationKobo = null;
    payout.expiresAt = null;
    banks.down = false;
    key = (await agents.createKey('Test agent', 20_000)).key;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('keys', () => {
    it('refuses no key, a wrong key and a revoked key, and stores only a hash', async () => {
      expect((await call('POST', '/v1/agent/quotes', REQUEST, null)).json().code).toBe('invalid_key');
      expect((await call('POST', '/v1/agent/quotes', REQUEST, 'wrong')).statusCode).toBe(401);
      const made = await agents.createKey('Other', 20_000);
      expect((await pool.query('select key_hash from agent_keys where id = $1', [made.id])).rows[0].key_hash).not.toContain(made.key);
      expect((await call('POST', '/v1/agent/quotes', REQUEST, made.key)).statusCode).toBe(200);
      await agents.revokeKey(made.id);
      expect((await call('POST', '/v1/agent/quotes', REQUEST, made.key)).statusCode).toBe(401);
    });

    it('needs the admin token to make a key', async () => {
      expect((await app.inject({ method: 'POST', url: '/v1/admin/agent-keys', payload: { name: 'x', daily_limit_naira: 1 } })).statusCode).toBe(401);
    });

    it('does not show one key another key\'s payment', async () => {
      const mine = await accepted();
      const other = await agents.createKey('Other', 1000);
      expect((await call('GET', `/v1/agent/payments/${mine.id}`, undefined, other.key)).statusCode).toBe(404);
      expect((await call('POST', '/v1/agent/payments', { quote_id: mine.id }, other.key)).statusCode).toBe(404);
    });
  });

  describe('quotes', () => {
    it('names the account, prices it, masks the number and moves nothing', async () => {
      const body = await quote();
      expect(body).toMatchObject({ status: 'quoted', amount_naira: 5000, account_name: 'Ada Bello', account_number: '****4568', usdc_delivered: '3.571429', pay_usdc: '3.573829', deposit_address: null });
      expect(JSON.stringify(body)).not.toContain('8031234568');
      expect(payout.deposits).toHaveLength(0);
      expect(crossChain.quotes).toHaveLength(0);
    });

    it.each([
      [{ amount_naira: 0 }, 'invalid_request', 400],
      [{ account_number: '123' }, 'invalid_request', 400],
      [{ pay_from: 'tron' }, 'invalid_request', 400],
      [{ pay_from: 'base', refund_to: 'agent.near' }, 'invalid_refund_address', 400],
      [{ account_number: '8031230000' }, 'account_not_found', 404],
      [{ amount_naira: 25_000 }, 'over_daily_limit', 422],
    ])('refuses %j', async (over, code, statusCode) => {
      const response = await call('POST', '/v1/agent/quotes', { ...REQUEST, ...over });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json().code).toBe(code);
    });

    it('refuses less than the partner minimum, and says what the minimum is', async () => {
      const provider = app.get(PaymentProvider, { strict: false });
      const spy = jest.spyOn(provider, 'minimumUsdcMinor').mockReturnValue(1_000_000);
      const response = await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 500 });
      spy.mockRestore();
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'below_minimum', message: expect.stringContaining('1,400') });
    });

    it('says when the bank cannot be asked, rather than that the account is missing', async () => {
      banks.down = true;
      const response = await call('POST', '/v1/agent/quotes', REQUEST);
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('bank_unavailable');
    });

    it('stops when payments are paused', async () => {
      const switches = app.get(SwitchesService, { strict: false });
      await switches.set('bank', true);
      try {
        expect((await call('POST', '/v1/agent/quotes', REQUEST)).json().code).toBe('paused');
      } finally {
        await switches.set('bank', false);
      }
    });
  });

  describe('accepting', () => {
    it('sets up the payout and the route, sending the exact amount to the partner', async () => {
      const body = await accepted();
      expect(body).toMatchObject({ status: 'awaiting_deposit', deposit_address: '0xdeposit', pay_usdc: '3.573829' });
      expect(payout.deposits[0]).toMatchObject({ route: 'bank', usdcMinor: 3_571_429, reference: body.id });
      expect(crossChain.quotes[0]).toMatchObject({ payFrom: 'near', usdcMinor: 3_571_429, recipient: '0xswitch', refundTo: 'agent.near' });
    });

    it('gives the same payment when asked again, and sets it up only once', async () => {
      const first = await quote();
      const a = (await call('POST', '/v1/agent/payments', { quote_id: first.id })).json();
      const b = (await call('POST', '/v1/agent/payments', { quote_id: first.id })).json();
      expect(b.deposit_address).toBe(a.deposit_address);
      expect(payout.deposits).toHaveLength(1);
    });

    it('refuses an expired quote', async () => {
      const first = await quote();
      await pool.query(`update agent_payments set quote_expires_at = now() - interval '1 minute'`);
      const response = await call('POST', '/v1/agent/payments', { quote_id: first.id });
      expect(response.statusCode).toBe(410);
      expect(response.json().code).toBe('quote_expired');
      expect(payout.deposits).toHaveLength(0);
    });

    it('lets the same quote try again when setting up fails, using the same reference', async () => {
      const first = await quote();
      crossChain.failNext = 1;
      const failed = await call('POST', '/v1/agent/payments', { quote_id: first.id });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe('setup_failed');
      expect(failed.body).not.toContain('secret detail');
      const again = (await call('POST', '/v1/agent/payments', { quote_id: first.id })).json();
      expect(again.status).toBe('awaiting_deposit');
      expect(payout.deposits.map((item) => item.reference)).toEqual([first.id, first.id]);
    });

    it('stops if the partner would pay noticeably less than quoted', async () => {
      payout.destinationKobo = 480_000;
      const first = await quote();
      const response = await call('POST', '/v1/agent/payments', { quote_id: first.id });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('price_changed');
      expect(crossChain.quotes).toHaveLength(0);
    });

    it('allows two payments up to the daily limit, then refuses, and even when requests arrive together', async () => {
      await accepted({ amount_naira: 12_000 });
      const [a, b] = await Promise.all([quote({ amount_naira: 7000 }), quote({ amount_naira: 7000 })]);
      const answers = await Promise.all([a, b].map((item) => call('POST', '/v1/agent/payments', { quote_id: item.id })));
      expect(answers.map((item) => item.statusCode).sort()).toEqual([200, 422]);
    });

    it('counts agent payments towards the company cap', async () => {
      // Other test files leave payments behind, and those count towards the same cap.
      await pool.query('TRUNCATE payments CASCADE');
      const big = await agents.createKey('Big', 9_000_000);
      const first = (await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 4_900_000 }, big.key)).json();
      expect((await call('POST', '/v1/agent/payments', { quote_id: first.id }, big.key)).statusCode).toBe(200);
      const response = await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 200_000 }, big.key);
      expect(response.json().code).toBe('paused');
    });
  });

  describe('x402', () => {
    const decode = (value: string | string[] | number | undefined) => JSON.parse(Buffer.from(String(value), 'base64').toString());
    const pay = (id: string, signature?: object, token: string = key) =>
      app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, headers: { authorization: `Bearer ${token}`, ...(signature ? { 'payment-signature': Buffer.from(JSON.stringify(signature)).toString('base64') } : {}) } });
    const signed = (id: string, payload: object, url = `http://localhost/v1/agent/x402/pay/${id}`) => ({ x402Version: 2, resource: { url }, accepted: {}, payload });

    const started = async () => {
      const { id } = await quote();
      const offer = await pay(id);
      const second = await pay(id, signed(id, { type: 'quote', refundTo: 'agent.near' }));
      return { id, offer, second, entry: decode(second.headers['payment-required']).accepts[0] };
    };

    it('offers first with nothing to pay yet, and moves nothing', async () => {
      const { id } = await quote();
      const offer = await pay(id);
      expect(offer.statusCode).toBe(402);
      const body = decode(offer.headers['payment-required']);
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0]).toMatchObject({ scheme: 'exact', network: 'near:mainnet', amount: '', payTo: '', extra: { assetTransferMethod: 'near-intents', paymentFlow: 'upfront', destination: { network: 'eip155:8453', amount: '3571429' } } });
      expect(payout.deposits).toHaveLength(0);
    });

    it('a quote payload gives the amount and address, and still does not count as paid', async () => {
      const { second, entry } = await started();
      expect(second.statusCode).toBe(402);
      expect(entry).toMatchObject({ amount: '3573829', payTo: '0xdeposit', extra: { destination: { recipient: '0xswitch' } } });
      expect(entry.extra.operationToken).toMatch(/^k1\./);
      expect(entry.extra.refundDeadline).toBeTruthy();
      expect(payout.deposits).toHaveLength(1);
    });

    it('a deposit payload reports pending, then settles with a receipt, without showing the token', async () => {
      const { id, entry } = await started();
      const deposit = signed(id, { type: 'deposit', operationToken: entry.extra.operationToken, depositAddress: '0xdeposit', txHash: '0xa' });
      crossChain.state = { status: 'moving', transactions: ['0xa'] };
      const pending = await pay(id, deposit);
      expect(pending.statusCode).toBe(402);
      expect(decode(pending.headers['payment-response'])).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: '0xa' });
      crossChain.state = { status: 'delivered', transactions: ['0xa', '0xb'] };
      payout.state = { state: 'completed' };
      const done = await pay(id, deposit);
      expect(done.statusCode).toBe(200);
      expect(decode(done.headers['payment-response'])).toMatchObject({ success: true, network: 'eip155:8453', transaction: '0xb', amount: '3571429', extra: { originNetwork: 'near:mainnet', originTxHash: '0xa' } });
      expect(done.json().payment.receipt.reference).toBe(id);
      expect(done.headers['payment-response']).not.toContain(entry.extra.operationToken);
      expect(payout.deposits).toHaveLength(1);
    });

    it('reports a failure when the money was refunded', async () => {
      const { id, entry } = await started();
      crossChain.state = { status: 'refunded', transactions: [] };
      const failed = await pay(id, signed(id, { type: 'deposit', operationToken: entry.extra.operationToken, depositAddress: '0xdeposit', txHash: '0xa' }));
      expect(failed.statusCode).toBe(402);
      expect(decode(failed.headers['payment-response'])).toMatchObject({ success: false, errorReason: 'exact_near_intents_payment_failed', extra: { status: 'refunded', refundTo: 'agent.near' } });
    });

    it('refuses a bad token, a wrong address, a wrong transaction, a wrong refund address and a wrong resource', async () => {
      const { id, entry } = await started();
      const good = { type: 'deposit', operationToken: entry.extra.operationToken, depositAddress: '0xdeposit', txHash: '0xa' };
      expect((await pay(id, signed(id, { ...good, operationToken: 'k1.9999999999.nope' }))).json().code).toBe('invalid_exact_near_intents_token_invalid');
      expect((await pay(id, signed(id, { ...good, depositAddress: '0xother' }))).json().code).toBe('invalid_exact_near_intents_token_invalid');
      crossChain.state = { status: 'moving', transactions: ['0xreal'] };
      await status(id);
      expect((await pay(id, signed(id, good))).json().code).toBe('invalid_exact_near_intents_deposit_not_found');
      const other = await quote();
      expect((await pay(other.id, signed(other.id, { type: 'quote', refundTo: 'someone.near' }))).json().code).toBe('invalid_refund_address');
      expect((await pay(other.id, signed(other.id, { type: 'quote', refundTo: 'agent.near' }, 'http://localhost/elsewhere'))).statusCode).toBe(400);
    });

    it('rejects a payload it cannot read, and another key cannot use it', async () => {
      const { id } = await quote();
      const garbled = await app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, headers: { authorization: `Bearer ${key}`, 'payment-signature': 'not base64 json' } });
      expect(garbled.statusCode).toBe(400);
      const other = await agents.createKey('Other', 20_000);
      expect((await pay(id, undefined, other.key)).statusCode).toBe(404);
    });

    it('still enforces the key limit when a quote payload accepts', async () => {
      const { id } = await quote({ amount_naira: 20_000 });
      await accepted({ amount_naira: 5000 });
      const refused = await pay(id, signed(id, { type: 'quote', refundTo: 'agent.near' }));
      expect(refused.json().code).toBe('over_daily_limit');
    });
  });

  describe('x402 with no key', () => {
    const start = (over: object = {}, ip = '10.0.0.1') =>
      app.inject({ method: 'POST', url: '/v1/agent/x402/pay', remoteAddress: ip, payload: { ...REQUEST, payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1042', ...over } });
    const decode = (value: string | string[] | number | undefined) => JSON.parse(Buffer.from(String(value), 'base64').toString());
    const signed = (id: string, payload: object) => ({ x402Version: 2, resource: { url: `http://localhost/v1/agent/x402/pay/${id}` }, payload });
    const pay = (id: string, signature: object, token?: string) =>
      app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'payment-signature': Buffer.from(JSON.stringify(signature)).toString('base64') } });
    const acceptKeyless = async (over: object, ip?: string) => {
      const { id } = (await start(over, ip)).json().payment;
      return pay(id, signed(id, { type: 'quote', refundTo: (over as { refund_to?: string }).refund_to ?? 'agent.near' }));
    };

    it('runs the whole journey with no key, keeping the details the agent gave', async () => {
      const first = await start();
      expect(first.statusCode).toBe(402);
      const { id } = first.json().payment;
      expect(decode(first.headers['payment-required']).accepts[0]).toMatchObject({ amount: '', payTo: '' });
      expect(decode(first.headers['payment-required']).resource.url).toContain(`/v1/agent/x402/pay/${id}`);
      const second = await pay(id, signed(id, { type: 'quote', refundTo: 'agent.near' }));
      const entry = decode(second.headers['payment-required']).accepts[0];
      expect(entry.payTo).toBe('0xdeposit');
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      const done = await pay(id, signed(id, { type: 'deposit', operationToken: entry.extra.operationToken, depositAddress: '0xdeposit', txHash: '0xa' }));
      expect(done.statusCode).toBe(200);
      const row = (await pool.query('select payer_name, payer_email, purpose, client_ip, status from agent_payments where id = $1', [id])).rows[0];
      expect(row).toMatchObject({ payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1042', client_ip: '10.0.0.1', status: 'paid' });
    });

    it('requires the details, and refuses over the limit for one payment', async () => {
      const missing = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', payload: REQUEST });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe('invalid_request');
      const big = await start({ amount_naira: 50_001 });
      expect(big.json().code).toBe('over_payment_limit');
      expect((await start({ amount_naira: 50_000 })).statusCode).toBe(402);
    });

    it('caps one wallet and one bank account per day', async () => {
      expect((await acceptKeyless({ amount_naira: 50_000, account_number: '8031234001' })).statusCode).toBe(402);
      expect((await acceptKeyless({ amount_naira: 50_000, account_number: '8031234002' })).statusCode).toBe(402);
      expect((await start({ amount_naira: 1000, account_number: '8031234003' })).json().code).toBe('over_wallet_limit');
      expect((await acceptKeyless({ amount_naira: 50_000, account_number: '8031234004', refund_to: 'b.near' })).statusCode).toBe(402);
      expect((await acceptKeyless({ amount_naira: 50_000, account_number: '8031234004', refund_to: 'c.near' })).statusCode).toBe(402);
      expect((await start({ amount_naira: 1000, account_number: '8031234004', refund_to: 'd.near' })).json().code).toBe('over_account_limit');
    });

    it('checks the wallet cap again at accepting, so quotes made together cannot pass it', async () => {
      const a = (await start({ amount_naira: 50_000, account_number: '8031234005', refund_to: 'e.near' })).json().payment.id;
      const b = (await start({ amount_naira: 50_000, account_number: '8031234006', refund_to: 'e.near' })).json().payment.id;
      const c = (await start({ amount_naira: 50_000, account_number: '8031234007', refund_to: 'e.near' })).json().payment.id;
      const answers = await Promise.all([a, b, c].map((id) => pay(id, signed(id, { type: 'quote', refundTo: 'e.near' }))));
      expect(answers.map((item) => item.statusCode).sort()).toEqual([402, 402, 422]);
    });

    it('caps the total of all keyless payments in a day', async () => {
      for (const n of [1, 2, 3, 4]) expect((await acceptKeyless({ amount_naira: 50_000, account_number: `803123410${n}`, refund_to: `w${n}.near` })).statusCode).toBe(402);
      expect((await start({ amount_naira: 1000, account_number: '8031234200', refund_to: 'w5.near' })).json().code).toBe('over_daily_limit');
    });

    it('slows repeated quotes from one address', async () => {
      const ip = '10.9.9.9';
      for (let n = 0; n < 30; n++) await start({ amount_naira: 1000 }, ip);
      expect((await start({ amount_naira: 1000 }, ip)).json().code).toBe('too_many_requests');
      expect((await start({ amount_naira: 1000 }, '10.9.9.10')).statusCode).toBe(402);
    });

    it('stops when paused, and when the keyless key is revoked', async () => {
      const switches = app.get(SwitchesService, { strict: false });
      await switches.set('bank', true);
      try {
        expect((await start()).json().code).toBe('paused');
      } finally {
        await switches.set('bank', false);
      }
      await start();
      await agents.revokeKey(KEYLESS_KEY_ID);
      expect((await start()).json().code).toBe('unavailable');
    });

    it('still uses a key when one is given, and refuses a wrong one', async () => {
      const withKey = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', headers: { authorization: `Bearer ${key}` }, payload: REQUEST });
      expect(withKey.statusCode).toBe(402);
      const wrong = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', headers: { authorization: 'Bearer wrong' }, payload: REQUEST });
      expect(wrong.statusCode).toBe(401);
    });

    it('keeps keyless payments out of a keyed agent, and the other way round', async () => {
      const mine = await quote();
      const keyless = await pay(mine.id, signed(mine.id, { type: 'quote', refundTo: 'agent.near' }));
      expect(keyless.statusCode).toBe(404);
      const theirs = (await start()).json().payment.id;
      expect((await call('GET', `/v1/agent/payments/${theirs}`)).statusCode).toBe(404);
    });
  });

  describe('the accountant spreadsheet', () => {
    it('lists a key\'s real payments with masked accounts, safely, and needs the key', async () => {
      const paying = await accepted();
      await quote({ amount_naira: 2000 });
      const response = await app.inject({ method: 'GET', url: '/v1/agent/payments.csv', headers: { authorization: `Bearer ${key}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      const lines = response.body.trim().split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Paid to');
      expect(lines[1]).toContain(paying.id);
      expect(response.body).toContain('****4568');
      expect(response.body).not.toContain('8031234568');
      expect((await app.inject({ method: 'GET', url: '/v1/agent/payments.csv' })).statusCode).toBe(401);
    });

    it('cannot be used to run a formula in a spreadsheet', () => {
      const csv = paymentsToCsv([{ createdAt: new Date(0), status: 'paid', accountName: '=HYPERLINK("x")', bankName: 'OPay', accountNumber: '8031234568', amountKobo: 100, payoutKobo: null, payToken: 'USDC', payInMinor: 1, payFrom: 'near', purpose: '@cmd, more', id: 'id', transactions: [] } as unknown as AgentPayment]);
      expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
      expect(csv).toContain(`"'@cmd, more"`);
    });
  });

  describe('the gas relayer', () => {
    const SIGNED = 'c2lnbmVkLWRlbGVnYXRl';
    const transfer = (over: Partial<SignedDelegate> = {}, args: object = { receiver_id: '0xdeposit', amount: '3573829' }, action: object = {}): SignedDelegate => ({
      senderId: 'agent.near',
      receiverId: USDC_ON_NEAR,
      actions: [{ method: 'ft_transfer', args: JSON.stringify(args), deposit: 1n, gas: 30_000_000_000_000n, ...action }],
      ...over,
    });
    const relay = (id: string, token: string = key) => app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}/relay`, headers: { authorization: `Bearer ${token}` }, payload: { signed_delegate: SIGNED } });

    beforeEach(() => {
      relayer.sent = [];
      relayer.registered = [];
      relayer.failSend = false;
      relayer.delegate = transfer();
    });

    it('sends the exact transfer, registers the deposit address, and records the transaction', async () => {
      const { id } = await accepted();
      const response = await relay(id);
      expect(response.statusCode).toBe(200);
      expect(response.json().transactions).toEqual(['0xrelayed']);
      expect(relayer.registered).toEqual(['0xdeposit']);
      expect(relayer.sent).toEqual([SIGNED]);
    });

    it.each<[string, () => SignedDelegate]>([
      ['someone else signing', () => transfer({ senderId: 'attacker.near' })],
      ['another contract', () => transfer({ receiverId: 'evil.near' })],
      ['another method', () => transfer({}, undefined, { method: 'storage_withdraw' })],
      ['a non-call action', () => transfer({}, undefined, { method: null })],
      ['two actions', () => { const one = transfer(); return { ...one, actions: [one.actions[0]!, one.actions[0]!] }; }],
      ['another receiver', () => transfer({}, { receiver_id: 'attacker.near', amount: '3573829' })],
      ['a different amount', () => transfer({}, { receiver_id: '0xdeposit', amount: '1' })],
      ['more than one yocto attached', () => transfer({}, undefined, { deposit: 10n ** 24n })],
      ['too much gas', () => transfer({}, undefined, { gas: 300_000_000_000_000n })],
      ['unreadable arguments', () => transfer({}, undefined, { args: 'not json' })],
    ])('refuses %s, and sends nothing', async (_name, make) => {
      const { id } = await accepted();
      relayer.delegate = make();
      const response = await relay(id);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('relay_refused');
      expect(relayer.sent).toHaveLength(0);
      expect(relayer.registered).toHaveLength(0);
    });

    it('pays once per payment, even when asked twice at once', async () => {
      const { id } = await accepted();
      const answers = await Promise.all([relay(id), relay(id)]);
      expect(answers.map((item) => item.statusCode).sort()).toEqual([200, 409]);
      expect(relayer.sent).toHaveLength(1);
    });

    it('does not try again after a failure, and says to check first', async () => {
      const { id } = await accepted();
      relayer.failSend = true;
      const failed = await relay(id);
      expect(failed.statusCode).toBe(502);
      expect(failed.json().message).toContain('may still have gone');
      relayer.failSend = false;
      expect((await relay(id)).json().code).toBe('already_relayed');
      expect(relayer.sent).toHaveLength(0);
    });

    it('refuses a payment that is not from NEAR, not waiting, or another key\'s', async () => {
      const base = await accepted({ pay_from: 'base', refund_to: REFUND });
      expect((await relay(base.id)).json().code).toBe('relay_refused');
      const quoted = await quote();
      expect((await relay(quoted.id)).json().code).toBe('relay_refused');
      const mine = await accepted({ amount_naira: 1000 });
      const other = await agents.createKey('Other', 20_000);
      expect((await relay(mine.id, other.key)).statusCode).toBe(404);
    });

    it('keeps a daily ceiling on what the relayer can spend', async () => {
      const { id } = await accepted();
      await pool.query(`insert into agent_payments (id, key_id, amount_kobo, usdc_minor, pay_in_minor, bank_name, account_number, account_name, pay_from, refund_to, quote_expires_at, relayed_at, status)
        select gen_random_uuid(), key_id, 100, 1, 1, 'OPay', '8031234568', 'x', 'near', 'a.near', now(), now(), 'expired' from agent_payments, generate_series(1, 100) where id = $1`, [id]);
      expect((await relay(id)).json().code).toBe('relayer_busy');
    });

    it('rejects a transfer it cannot read', async () => {
      const { id } = await accepted();
      relayer.delegate = null;
      expect((await relay(id)).json().code).toBe('invalid_request');
    });
  });

  describe('merchant checkout', () => {
    let merchants: MerchantService;
    let shopKey: string;
    let secret: string;
    let keyId: string;
    const notices: { url: string; headers: Record<string, string>; body: string }[] = [];
    let shopAnswers = 200;
    const open = (id: string) => app.inject({ method: 'GET', url: `/v1/public/pay-links/${id}` });
    const payLink = (id: string) => app.inject({ method: 'POST', url: `/v1/public/pay-links/${id}/pay`, remoteAddress: '10.8.8.8', payload: { pay_from: 'arbitrum', refund_to: REFUND } });
    const shop = (method: 'GET' | 'POST', url: string, body?: object, token: string | null = shopKey) =>
      app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(body ? { payload: body } : {}) });
    const ORDER = { reference: 'order-1001', line_items: [{ description: 'Jollof rice', amount_naira: 3000 }, { description: 'Delivery', amount_naira: 1000 }], note: 'Order 1001', return_url: 'https://shop.example/thanks?order=1001' };

    beforeEach(async () => {
      merchants = app.get(MerchantService, { strict: false });
      await pool.query('TRUNCATE users CASCADE');
      await pool.query(`insert into users (provider_subject, email) values ('did:privy:shop', 'owner@shop.example')`);
      notices.length = 0;
      shopAnswers = 200;
      merchants.fetchFn = (async (url: string, init: RequestInit) => {
        notices.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
        return new Response(null, { status: shopAnswers });
      }) as unknown as typeof fetch;
      const made = await merchants.createKey({ userEmail: 'owner@shop.example', name: 'Mama Put Kitchen', payout: { bankName: 'OPay', accountNumber: '8031234568' }, returnOrigins: ['https://shop.example'], webhookUrl: 'https://shop.example/hooks/10kobo' });
      shopKey = made.key;
      secret = made.webhookSecret!;
      keyId = made.id;
    });

    it('lets a shop make an invoice with its key, and the payer sees the shop and a way back', async () => {
      const made = await shop('POST', '/v1/merchant/invoices', ORDER);
      expect(made.statusCode).toBe(200);
      const invoice = made.json();
      expect(invoice).toMatchObject({ reference: 'order-1001', status: 'unpaid', amount_naira: 4000, receives: 'naira, OPay ****4568', return_url: 'https://shop.example/thanks?order=1001' });
      expect(invoice.checkout_url).toContain(`/pay/${invoice.id}`);
      expect((await open(invoice.id)).json()).toMatchObject({ merchant: 'Mama Put Kitchen', return_url: 'https://shop.example/thanks?order=1001', amount_naira: 4000, open: true });
      expect((await shop('GET', `/v1/merchant/invoices/${invoice.id}`)).json().status).toBe('unpaid');
    });

    it('gives the same invoice for the same reference, and refuses that reference for another amount', async () => {
      const first = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      const again = await Promise.all([shop('POST', '/v1/merchant/invoices', ORDER), shop('POST', '/v1/merchant/invoices', ORDER)]);
      expect(again.map((response) => response.json().id)).toEqual([first.id, first.id]);
      const changed = await shop('POST', '/v1/merchant/invoices', { reference: 'order-1001', amount_naira: 9000 });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('reference_used');
    });

    it('refuses a bad key, a revoked key, a return address on another website, and another shop\'s invoice', async () => {
      expect((await shop('POST', '/v1/merchant/invoices', ORDER, 'mk_wrong')).statusCode).toBe(401);
      expect((await shop('POST', '/v1/merchant/invoices', ORDER, null)).statusCode).toBe(401);
      const elsewhere = await shop('POST', '/v1/merchant/invoices', { ...ORDER, reference: 'x', return_url: 'https://evil.example/' });
      expect(elsewhere.json()).toMatchObject({ code: 'invalid_request', message: 'The return address must be on a website registered for this key.' });
      expect((await shop('POST', '/v1/merchant/invoices', { ...ORDER, reference: 'y', return_url: 'http://shop.example/' })).json().message).toContain('https');

      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      const other = await merchants.createKey({ userEmail: 'owner@shop.example', name: 'Other shop', payout: { nearAccount: 'other.near' } });
      expect((await shop('GET', `/v1/merchant/invoices/${invoice.id}`, undefined, other.key)).statusCode).toBe(404);
      expect((await shop('POST', `/v1/merchant/invoices/${invoice.id}/cancel`, undefined, other.key)).statusCode).toBe(404);
      await merchants.revokeKey(keyId);
      expect((await shop('GET', `/v1/merchant/invoices/${invoice.id}`)).statusCode).toBe(401);
    });

    it('pays out only where the key says, whatever the shop sends', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', { ...ORDER, bank_name: 'Kuda', account_number: '0000000001', usdc_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })).json();
      expect(invoice.receives).toBe('naira, OPay ****4568');
    });

    it('tells the shop once when an invoice is paid, signed so the shop can check it, and retries when the shop is down', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      await merchants.reconcile();
      expect(notices).toHaveLength(0);

      await payLink(invoice.id);
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      expect((await open(invoice.id)).json().paid).toBe(true);

      shopAnswers = 500;
      await merchants.reconcile();
      expect(notices).toHaveLength(1);
      await merchants.reconcile();
      expect(notices).toHaveLength(1);
      await pool.query(`update merchant_events set next_attempt_at = now()`);
      shopAnswers = 200;
      await merchants.reconcile();
      expect(notices).toHaveLength(2);
      await pool.query(`update merchant_events set next_attempt_at = now()`);
      await merchants.reconcile();
      expect(notices).toHaveLength(2);

      const notice = notices[1]!;
      expect(notice.url).toBe('https://shop.example/hooks/10kobo');
      const body = JSON.parse(notice.body);
      expect(body).toMatchObject({ type: 'invoice.paid', data: { id: invoice.id, reference: 'order-1001', status: 'paid' } });
      expect(notice.headers['10kobo-event-id']).toBe(body.id);
      const timestamp = Number(/t=(\d+)/.exec(notice.headers['10kobo-signature']!)![1]);
      expect(notice.headers['10kobo-signature']).toBe(signNotice(secret, timestamp, notice.body));
      expect(notice.headers['10kobo-signature']).not.toBe(signNotice('whsec_wrong', timestamp, notice.body));
      const [row] = (await pool.query('select attempts, delivered_at from merchant_events')).rows;
      expect(row.attempts).toBe(2);
      expect(row.delivered_at).not.toBeNull();
    });

    it('lets a shop cancel an unpaid invoice, and tells it so', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      const cancelled = await shop('POST', `/v1/merchant/invoices/${invoice.id}/cancel`);
      expect(cancelled.json().status).toBe('cancelled');
      expect((await payLink(invoice.id)).json().code).toBe('link_cancelled');
      await merchants.reconcile();
      expect(JSON.parse(notices[0]!.body)).toMatchObject({ type: 'invoice.cancelled', data: { reference: 'order-1001' } });
    });

    it('can pay a shop in USDC on Base or NEAR instead of a bank, set on the key', async () => {
      const wallet = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
      const onBase = await merchants.createKey({ userEmail: 'owner@shop.example', name: 'USDC shop', payout: { usdcAddress: wallet } });
      const base = (await shop('POST', '/v1/merchant/invoices', { reference: 'b-1', amount_naira: 2000 }, onBase.key)).json();
      expect(base.receives).toBe('USDC on Base');
      expect(base.to).toBe(wallet);
      const onNear = await merchants.createKey({ userEmail: 'owner@shop.example', name: 'NEAR shop', payout: { nearAccount: 'shop.near' } });
      expect((await shop('POST', '/v1/merchant/invoices', { reference: 'n-1', amount_naira: 2000 }, onNear.key)).json()).toMatchObject({ receives: 'USDC on NEAR', to: 'shop.near' });
      await payLink(base.id);
      expect(crossChain.quotes.at(-1)).toMatchObject({ recipient: wallet, toNear: false });
      expect(payout.deposits).toHaveLength(0);
      await expect(merchants.createKey({ userEmail: 'owner@shop.example', name: 'x', payout: { usdcAddress: '0x12' } })).rejects.toThrow('valid Base address');
      await expect(merchants.createKey({ userEmail: 'owner@shop.example', name: 'x', payout: { toMyWallet: true } })).rejects.toThrow('no 10kobo wallet');
    });

    it('refuses keys that would send payers or notices somewhere unsafe', async () => {
      const bank = { bankName: 'OPay', accountNumber: '8031234568' };
      await expect(merchants.createKey({ userEmail: 'owner@shop.example', name: 'x', payout: bank, webhookUrl: 'http://shop.example/hook' })).rejects.toThrow('https');
      await expect(merchants.createKey({ userEmail: 'owner@shop.example', name: 'x', payout: bank, returnOrigins: ['https://shop.example/path'] })).rejects.toThrow('start of an address');
      await expect(merchants.createKey({ userEmail: 'nobody@shop.example', name: 'x', payout: bank })).rejects.toThrow('No 10kobo user');
      await expect(merchants.createKey({ userEmail: 'owner@shop.example', name: 'x', payout: bank, webhookUrl: 'http://localhost:3010/hook' })).resolves.toMatchObject({ key: expect.stringMatching(/^mk_/) });
    });
  });

  describe('pay links', () => {
    const user = { id: '', walletAddress: null } as unknown as User;
    let links: PayLinksService;
    const open = (id: string) => app.inject({ method: 'GET', url: `/v1/public/pay-links/${id}` });
    const payLink = (id: string, body: object = { pay_from: 'arbitrum', refund_to: REFUND }, ip = '10.7.7.7') => app.inject({ method: 'POST', url: `/v1/public/pay-links/${id}/pay`, remoteAddress: ip, payload: body });

    beforeEach(async () => {
      links = app.get(PayLinksService, { strict: false });
      await pool.query('TRUNCATE users CASCADE');
      user.id = (await pool.query(`insert into users (provider_subject) values ('did:privy:links') returning id`)).rows[0].id;
    });

    it('shows a payer what they need and no more, and a link needs no sign-in', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', note: 'Rent' });
      expect(links.url(link)).toContain(`/pay/${link.id}`);
      const response = await open(link.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ amount_naira: 5000, to: 'Ad* Be***', account_number: '****4568', note: 'Rent', open: true, paid: false, payment: null });
      expect(response.body).not.toContain('Ada Bello');
      expect(response.body).not.toContain('8031234568');
    });

    it('takes a payment from any chain through to paid, then closes', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      const paying = (await payLink(link.id)).json();
      expect(paying.payment).toMatchObject({ status: 'awaiting_deposit', pay_from: 'arbitrum', deposit_address: '0xdeposit' });
      expect(crossChain.quotes[0]).toMatchObject({ payFrom: 'arbitrum', refundTo: REFUND });
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      expect((await open(link.id)).json()).toMatchObject({ paid: true, open: false, payment: { status: 'paid', deposit_address: null } });
      const again = await payLink(link.id);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('already_paid');
    });

    it('can pay USDC to the user\'s own wallet or a Base address instead of a bank, with no bank payout', async () => {
      const wallet = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
      const link = await links.create({ ...user, walletAddress: wallet } as User, { amountNaira: 5000, toMyWallet: true, note: 'Repair' });
      expect((await open(link.id)).json()).toMatchObject({ to: wallet, receives: 'USDC on Base', account_number: null });
      const before = payout.deposits.length;
      const paying = (await payLink(link.id)).json();
      expect(paying.payment.receiver_gets_usdc).toEqual(expect.any(String));
      expect(crossChain.quotes.at(-1)).toMatchObject({ recipient: wallet, toNear: false });
      expect(payout.deposits).toHaveLength(before);
      crossChain.state = { status: 'delivered', transactions: ['0x' + 'a'.repeat(64)] };
      const paid = (await open(link.id)).json();
      expect(paid).toMatchObject({ paid: true, payment: { status: 'paid', links: [{ label: 'Delivery on Base' }] } });

      const other = await links.create(user, { amountNaira: 1000, usdcAddress: wallet });
      expect((await open(other.id)).json()).toMatchObject({ to: wallet, receives: 'USDC on Base' });
    });

    it('refuses a USDC receiver that cannot work', async () => {
      await expect(links.create(user, { amountNaira: 1000, toMyWallet: true })).rejects.toThrow('still being set up');
      await expect(links.create(user, { amountNaira: 1000, usdcAddress: '0x123' })).rejects.toThrow('not a valid Base address');
      await expect(links.create(user, { amountNaira: 1000, usdcAddress: '0x0000000000000000000000000000000000000000' })).rejects.toThrow('zero address');
      crossChain.missingNear.add('nobody.near');
      await expect(links.create(user, { amountNaira: 1000, nearAccount: 'nobody.near' })).rejects.toThrow('does not exist');
    });

    it('stops offering an address once the time to send has passed, and lets the payer start again', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      const first = (await payLink(link.id)).json().payment;
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '1 second' where id = $1`, [first.id]);
      expect((await open(link.id)).json()).toMatchObject({ open: true, payment: { id: first.id, status: 'expired', deposit_address: null, deposit_deadline: null, failure_reason: 'No payment arrived in time.' } });
      const second = (await payLink(link.id)).json().payment;
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ status: 'awaiting_deposit', deposit_address: '0xdeposit' });
    });

    it('keeps an invoice payable past its due date, and refuses a date more than a year away', async () => {
      const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', dueDate: inDays(60) });
      expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now() + 70 * 86_400_000);
      const soon = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', dueDate: inDays(1) });
      expect(soon.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
      await expect(links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', dueDate: inDays(400) })).rejects.toThrow('at most a year');
    });

    it('lists the user\'s invoices with a plain status, and cancelling one stops it being paid', async () => {
      const make = () => links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', note: 'Repair' });
      const status = async () => Object.fromEntries((await links.list(user)).map((row) => [row.link.id, presentOwnLink(row, 'u').status]));
      const unpaid = await make();
      const paying = await make();
      const overdue = await make();
      await pool.query(`update pay_links set due_date = '2020-01-01' where id = $1`, [overdue.id]);
      await payLink(paying.id);
      expect(await status()).toEqual({ [unpaid.id]: 'unpaid', [paying.id]: 'being_paid', [overdue.id]: 'overdue' });
      expect(presentOwnLink((await links.list(user))[0]!, 'u')).toMatchObject({ to: 'Ada Bello', receives: 'naira, OPay ****4568' });

      await expect(links.cancel(user, paying.id)).rejects.toThrow('paying this invoice right now');
      await links.cancel(user, unpaid.id);
      expect((await status())[unpaid.id]).toBe('cancelled');
      expect((await open(unpaid.id)).json()).toMatchObject({ open: false, cancelled: true });
      const refused = await payLink(unpaid.id);
      expect(refused.statusCode).toBe(410);
      expect(refused.json().code).toBe('link_cancelled');

      const stranger = { id: (await pool.query(`insert into users (provider_subject) values ('did:privy:stranger') returning id`)).rows[0].id } as User;
      await expect(links.cancel(stranger, overdue.id)).rejects.toThrow('does not exist');
      expect(await links.list(stranger)).toEqual([]);
      expect((await app.inject({ method: 'GET', url: '/v1/pay-links' })).statusCode).toBe(401);
    });

    it('cannot cancel an invoice that has been paid', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      await payLink(link.id);
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      expect((await open(link.id)).json().paid).toBe(true);
      await expect(links.cancel(user, link.id)).rejects.toThrow('has been paid');
      expect(presentOwnLink((await links.list(user))[0]!, 'u').status).toBe('paid');
    });

    it('says plainly when the NEAR refund account does not exist, and offers no address', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      crossChain.missingNear.add('10kokbo.near');
      const response = await payLink(link.id, { pay_from: 'near', refund_to: '10kokbo.near' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_refund_address', message: 'The NEAR account 10kokbo.near does not exist. Check the spelling.' });
      expect((await open(link.id)).json().payment).toBeNull();
    });

    it('gives the same payment on a refresh, and allows a new one after it expires', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      const first = (await payLink(link.id)).json().payment.id;
      expect((await payLink(link.id)).json().payment.id).toBe(first);
      expect(payout.deposits).toHaveLength(1);
      await pool.query(`update agent_payments set status = 'expired' where id = $1`, [first]);
      expect((await payLink(link.id)).json().payment.id).not.toBe(first);
    });

    it('refuses an expired link, a bad account, too much, a bad refund address and an unknown link', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      expect((await payLink(link.id, { pay_from: 'near', refund_to: 'NOT VALID!' })).json().code).toBe('invalid_refund_address');
      await pool.query('update pay_links set expires_at = now() - interval \'1 minute\' where id = $1', [link.id]);
      expect((await payLink(link.id)).json().code).toBe('link_expired');
      await expect(links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031230000' })).rejects.toThrow('could not find');
      await expect(links.create(user, { amountNaira: 50_001, bankName: 'OPay', accountNumber: '8031234568' })).rejects.toThrow('most for one pay link');
      expect((await open('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    });

    it('works as an invoice: due date and items are shown, must add up, and cannot be in the past', async () => {
      const lineItems = [{ description: 'Generator repair', amountNaira: 3000 }, { description: 'Parts', amountNaira: 2000 }];
      const due = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
      const link = await links.create(user, { lineItems, dueDate: due, bankName: 'OPay', accountNumber: '8031234568', note: 'Invoice 7' });
      expect((await open(link.id)).json()).toMatchObject({ amount_naira: 5000, due_date: due, overdue: false, line_items: [{ description: 'Generator repair', amount_naira: 3000 }, { description: 'Parts', amount_naira: 2000 }] });
      await expect(links.create(user, { amountNaira: 9000, lineItems, bankName: 'OPay', accountNumber: '8031234568' })).rejects.toThrow('add up');
      await expect(links.create(user, { amountNaira: 5000, dueDate: '2020-01-01', bankName: 'OPay', accountNumber: '8031234568' })).rejects.toThrow('already passed');
      await pool.query(`update pay_links set due_date = '2020-01-01' where id = $1`, [link.id]);
      expect((await open(link.id)).json()).toMatchObject({ overdue: true, open: true });
    });

    it('can pay USDC on NEAR with no bank, marking it paid on delivery alone', async () => {
      const link = await links.create(user, { amountNaira: 5000, nearAccount: 'ada.near' });
      const shown = (await open(link.id)).json();
      expect(shown).toMatchObject({ to: 'ada.near', receives: 'USDC on NEAR', account_number: null });
      expect((await payLink(link.id)).json().payment.status).toBe('awaiting_deposit');
      expect(payout.deposits).toHaveLength(0);
      expect(crossChain.quotes[0]).toMatchObject({ recipient: 'ada.near', toNear: true, payFrom: 'arbitrum' });
      crossChain.state = { status: 'delivered', transactions: ['nearhash'] };
      expect((await open(link.id)).json()).toMatchObject({ paid: true, payment: { status: 'paid', links: [{ label: 'NEAR Intents settlement', url: 'https://nearblocks.io/txns/nearhash' }] } });
      await expect(links.create(user, { amountNaira: 5000, nearAccount: 'not a near account' })).rejects.toThrow('not a valid NEAR');
      await expect(links.create(user, { amountNaira: 5000 })).rejects.toThrow('bank and account number');
    });

    it('takes USDT only from chains that have it, and asks the route for USDT', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      expect((await payLink(link.id, { pay_from: 'base', pay_token: 'USDT', refund_to: REFUND })).json().code).toBe('token_unavailable');
      const paying = (await payLink(link.id, { pay_from: 'near', pay_token: 'USDT', refund_to: 'agent.near' })).json();
      expect(paying.payment).toMatchObject({ pay_token: 'USDT', pay_from: 'near' });
      expect(crossChain.quotes[0]).toMatchObject({ payToken: 'USDT' });
    });

    it('shows proof links once delivered', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      await payLink(link.id);
      crossChain.state = { status: 'delivered', transactions: ['nearhash', `0x${'a'.repeat(64)}`] };
      payout.state = { state: 'completed' };
      expect((await open(link.id)).json().payment.links).toEqual([
        { label: 'NEAR Intents settlement', url: 'https://nearblocks.io/txns/nearhash' },
        { label: 'Delivery on Base', url: `https://basescan.org/tx/0x${'a'.repeat(64)}` },
      ]);
    });

    it('puts a paid link in the maker\'s activity and spreadsheet, and only the maker\'s', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', note: 'Invoice 7' });
      await payLink(link.id);
      const wallet = app.get(WalletService, { strict: false });
      expect((await wallet.activityPage(user.id, 1, 6)).total).toBe(0);
      crossChain.state = { status: 'delivered', transactions: [`0x${'b'.repeat(64)}`] };
      payout.state = { state: 'completed' };
      await open(link.id);
      const page = await wallet.activityPage(user.id, 1, 6);
      expect(page.total).toBe(1);
      expect(page.activity[0]).toMatchObject({ type: 'pay_link', direction: 'in', description: 'Paid by link: Invoice 7', detail: 'OPay ****4568', amount_naira: '₦5,000' });
      const csv = await wallet.activityCsv(user.id);
      expect(csv).toContain('Paid by link: Invoice 7');
      expect(csv).toContain('Money in');
      expect(csv).not.toContain('8031234568');
      const other = (await pool.query(`insert into users (provider_subject) values ('did:privy:other') returning id`)).rows[0].id;
      expect((await wallet.activityPage(other, 1, 6)).total).toBe(0);
    });

    it('needs sign-in to make a link, and uses the same limits as paying without a key', async () => {
      expect((await app.inject({ method: 'POST', url: '/v1/pay-links', payload: { amount_naira: 5000, bank_name: 'OPay', account_number: '8031234568' } })).statusCode).toBe(401);
      for (const n of [1, 2]) {
        const link = await links.create(user, { amountNaira: 50_000, bankName: 'OPay', accountNumber: '8031234568' });
        expect((await payLink(link.id, { pay_from: 'arbitrum', refund_to: n === 1 ? REFUND : '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })).statusCode).toBe(200);
      }
      const third = await links.create(user, { amountNaira: 1000, bankName: 'OPay', accountNumber: '8031234568' });
      expect((await payLink(third.id, { pay_from: 'arbitrum', refund_to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' })).json().code).toBe('over_account_limit');
    });
  });

  describe('what the security review found', () => {
    it('counts a payment on the day it is accepted, so quotes saved from yesterday cannot pass the limit', async () => {
      const [a, b] = [await quote({ amount_naira: 15_000 }), await quote({ amount_naira: 15_000 })];
      await pool.query(`update agent_payments set created_at = now() - interval '2 days'`);
      expect((await call('POST', '/v1/agent/payments', { quote_id: a.id })).statusCode).toBe(200);
      const second = await call('POST', '/v1/agent/payments', { quote_id: b.id });
      expect(second.statusCode).toBe(422);
      expect(second.json().code).toBe('over_daily_limit');
    });

    it.each(['paid', 'refunded', 'expired', 'needs_support'])('never offers an address to pay once a payment is %s', async (final) => {
      const { id } = await accepted();
      await pool.query(`update agent_payments set status = $1 where id = $2`, [final, id]);
      const again = (await call('POST', '/v1/agent/payments', { quote_id: id })).json();
      expect(again.deposit_address).toBeNull();
      expect((await status(id)).deposit_address).toBeNull();
      const x402 = await app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, headers: { authorization: `Bearer ${key}`, 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://localhost/v1/agent/x402/pay/${id}` }, payload: { type: 'quote', refundTo: 'agent.near' } })).toString('base64') } });
      expect(x402.headers['payment-required']).toBeUndefined();
      expect(x402.body).not.toContain('0xdeposit');
    });

    it('does not call a payment expired at the deadline it told the agent, but gives it time to be seen', async () => {
      const { id } = await accepted();
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '1 minute'`);
      expect((await status(id)).status).toBe('awaiting_deposit');
    });

    it('gives the route a later deadline than the agent, so a last-moment deposit still completes', async () => {
      const { deposit_deadline: told } = await accepted();
      expect(crossChain.quotes[0]!.deadline.getTime()).toBeGreaterThan(new Date(told).getTime() + 5 * 60_000);
    });

    it('notices money that moves after a payment expired, including from the background job', async () => {
      const { id } = await accepted();
      await pool.query(`update agent_payments set status = 'expired', deposit_deadline = now() - interval '1 hour'`);
      expect((await status(id)).status).toBe('expired');
      crossChain.state = { status: 'moving', transactions: ['0xa'] };
      await agents.reconcile();
      expect((await pool.query('select status from agent_payments where id = $1', [id])).rows[0].status).toBe('processing');
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      expect((await status(id)).status).toBe('paid');
    });

    it('stops watching an expired payment after a day', async () => {
      const { id } = await accepted();
      await pool.query(`update agent_payments set status = 'expired', updated_at = now() - interval '2 days'`);
      crossChain.state = { status: 'delivered', transactions: [] };
      expect((await status(id)).status).toBe('expired');
    });

    it('asks for a person when a bank payment has not finished after a day', async () => {
      const { id } = await accepted();
      crossChain.state = { status: 'delivered', transactions: [] };
      expect((await status(id)).status).toBe('paying');
      await pool.query(`update agent_payments set accepted_at = now() - interval '2 days'`);
      const body = await status(id);
      expect(body.status).toBe('needs_support');
      expect(body.failure_reason).toContain('Do not send again');
    });

    it('refuses a partner window too short for the route', async () => {
      payout.expiresAt = new Date(Date.now() + 8 * 60_000).toISOString();
      const first = await quote();
      const response = await call('POST', '/v1/agent/payments', { quote_id: first.id });
      expect(response.json().code).toBe('setup_failed');
      expect(crossChain.quotes).toHaveLength(0);
    });

    it('ends the route before the partner window closes', async () => {
      const ends = Date.now() + 20 * 60_000;
      payout.expiresAt = new Date(ends).toISOString();
      await accepted();
      expect(crossChain.quotes[0]!.deadline.getTime()).toBeLessThanOrEqual(ends - 5 * 60_000 + 1000);
    });

    it('lets a setup that finishes late change nothing once its payment was reset', async () => {
      const first = await quote();
      const realQuote = crossChain.quote.bind(crossChain);
      jest.spyOn(crossChain, 'quote').mockImplementationOnce(async (request) => {
        await pool.query(`update agent_payments set status = 'quoted', accepted_at = null where id = $1`, [first.id]);
        return realQuote(request);
      });
      const response = await call('POST', '/v1/agent/payments', { quote_id: first.id });
      expect(response.statusCode).toBe(503);
      const row = (await pool.query('select status, deposit_address from agent_payments where id = $1', [first.id])).rows[0];
      expect(row).toEqual({ status: 'quoted', deposit_address: null });
    });

    it('gives keyless callers a partly hidden name, everywhere, and a keyed agent the full one', async () => {
      const keyless = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', payload: { ...REQUEST, payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1' } });
      expect(keyless.json().payment.account_name).toBe('Ad* Be***');
      expect(keyless.body).not.toContain('Ada Bello');
      expect((await quote()).account_name).toBe('Ada Bello');
    });

    it('does not ask the bank about an account until the other checks pass', async () => {
      const provider = app.get(PaymentProvider, { strict: false });
      const lookup = jest.spyOn(banks, 'accountName');
      const spy = jest.spyOn(provider, 'minimumUsdcMinor').mockReturnValue(1_000_000);
      await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 500 });
      spy.mockRestore();
      expect(lookup).not.toHaveBeenCalled();
      lookup.mockRestore();
    });

    it('limits accepts per address, so one caller cannot hold everyone\'s allowance', async () => {
      const ip = '10.5.5.5';
      const start = (n: number) => app.inject({ method: 'POST', url: '/v1/agent/x402/pay', remoteAddress: ip, payload: { ...REQUEST, amount_naira: 1000, account_number: `80312350${String(n).padStart(2, '0')}`, refund_to: `r${n}.near`, payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1' } });
      const accept = async (n: number) => {
        const { id } = (await start(n)).json().payment;
        return app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, remoteAddress: ip, headers: { 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://localhost/v1/agent/x402/pay/${id}` }, payload: { type: 'quote', refundTo: `r${n}.near` } })).toString('base64') } });
      };
      for (let n = 0; n < 10; n++) expect((await accept(n)).statusCode).toBe(402);
      expect((await accept(10)).json().code).toBe('too_many_requests');
    });

    it('keeps a daily ceiling on keyless quotes', async () => {
      await agents.keylessKey();
      await pool.query(`insert into agent_payments (id, key_id, amount_kobo, usdc_minor, pay_in_minor, bank_name, account_number, account_name, pay_from, refund_to, quote_expires_at)
        select gen_random_uuid(), $1, 100, 1, 1, 'OPay', '8031234568', 'x', 'near', 'a.near', now() from generate_series(1, 2000)`, [KEYLESS_KEY_ID]);
      const response = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', payload: { ...REQUEST, payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1' } });
      expect(response.json().code).toBe('too_many_requests');
    });
  });

  describe('following the money', () => {
    it('goes from waiting to moving to paying to paid, with a receipt', async () => {
      const { id } = await accepted();
      expect((await status(id)).status).toBe('awaiting_deposit');
      crossChain.state = { status: 'moving', transactions: ['0xa'] };
      expect((await status(id)).status).toBe('processing');
      crossChain.state = { status: 'delivered', transactions: ['0xa', 'b'] };
      expect((await status(id)).status).toBe('paying');
      payout.state = { state: 'completed' };
      const done = await status(id);
      expect(done).toMatchObject({ status: 'paid', transactions: ['0xa', 'b'], receipt: { to: 'Ada Bello, OPay ****4568', reference: id } });
      expect(JSON.stringify(done)).not.toContain('8031234568');
    });

    it('reports a refund', async () => {
      const { id } = await accepted();
      crossChain.state = { status: 'refunded', transactions: [] };
      expect(await status(id)).toMatchObject({ status: 'refunded' });
    });

    it('asks for a person, and says not to send again, when delivery or the bank fails', async () => {
      const crossed = await accepted({ amount_naira: 3000 });
      crossChain.state = { status: 'failed', transactions: [] };
      expect((await status(crossed.id)).failure_reason).toContain('Do not send again');
      const banked = await accepted({ amount_naira: 3000 });
      crossChain.state = { status: 'delivered', transactions: [] };
      payout.state = { state: 'failed', reason: 'bank said no' };
      const body = await status(banked.id);
      expect(body.status).toBe('needs_support');
      expect(body.failure_reason).toContain('Do not send again');
      expect(JSON.stringify(body)).not.toContain('bank said no');
    });

    it('expires when nothing arrives by the deadline, freeing the limit', async () => {
      const { id } = await accepted({ amount_naira: 20_000 });
      expect((await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 5000 })).json().code).toBe('over_daily_limit');
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '20 minutes'`);
      expect((await status(id)).status).toBe('expired');
      expect((await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 5000 })).statusCode).toBe(200);
    });

    it('keeps the last known state when a partner cannot be asked', async () => {
      const { id } = await accepted();
      jest.spyOn(crossChain, 'status').mockRejectedValueOnce(new Error('down'));
      expect((await status(id)).status).toBe('awaiting_deposit');
    });

    it('the background job moves payments on, and recovers one stuck being set up', async () => {
      const { id } = await accepted();
      crossChain.state = { status: 'moving', transactions: [] };
      await agents.reconcile();
      expect((await pool.query('select status from agent_payments where id = $1', [id])).rows[0].status).toBe('processing');
      const stuck = await quote();
      await pool.query(`update agent_payments set status = 'creating', updated_at = now() - interval '10 minutes' where id = $1`, [stuck.id]);
      await agents.reconcile();
      expect((await pool.query('select status from agent_payments where id = $1', [stuck.id])).rows[0].status).toBe('quoted');
    });
  });
});

describe('Agent API in test mode, with no keys and no overrides', () => {
  it('runs the whole journey, moving nothing', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const { key } = await app.get(AgentApiService, { strict: false }).createKey('Judge', 100_000);
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      (await app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) })).json();
    const quote = await call('POST', '/v1/agent/quotes', REQUEST);
    expect(quote.account_name).toContain('SIMULATED');
    const payment = await call('POST', '/v1/agent/payments', { quote_id: quote.id });
    expect(payment.deposit_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect((await call('GET', `/v1/agent/payments/${payment.id}`)).status).toBe('awaiting_deposit');
    const done = await call('GET', `/v1/agent/payments/${payment.id}`);
    expect(done.status).toBe('paid');
    expect(done.receipt.reference).toBe(payment.id);
    await app.close();
  });
});

describe('Agent API rules', () => {
  it('groups IPv6 addresses by block, and leaves IPv4 alone', () => {
    expect(ipGroup('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2');
    expect(ipGroup('2001:db8:1:2:ffff:4:5:6')).toBe(ipGroup('2001:db8:1:2:3:4:5:6'));
    expect(ipGroup('10.0.0.1')).toBe('10.0.0.1');
    expect(ipGroup('::ffff:10.0.0.1')).toBe('::ffff:10.0.0.1');
  });

  it('hides most of a name, and keeps short words readable', () => {
    expect(maskName('Ada Bello')).toBe('Ad* Be***');
    expect(maskName('Bo  Li')).toBe('Bo Li');
  });

  it('keeps an operation token bound to its payment and resource, and lets it expire', () => {
    const payment = { payFrom: 'near', depositAddress: '0xdeposit', payoutAddress: '0xswitch', usdcMinor: 1_050_000 } as AgentPayment;
    const later = Math.floor(Date.now() / 1000) + 100;
    const token = operationToken('secret', payment, '/resource', later);
    expect(tokenProblem('secret', payment, '/resource', token)).toBeNull();
    expect(tokenProblem('other', payment, '/resource', token)).toBe('invalid_exact_near_intents_token_invalid');
    expect(tokenProblem('secret', payment, '/different', token)).toBe('invalid_exact_near_intents_token_invalid');
    expect(tokenProblem('secret', { ...payment, usdcMinor: 2 }, '/resource', token)).toBe('invalid_exact_near_intents_token_invalid');
    expect(tokenProblem('secret', payment, '/resource', `${token.slice(0, -1)}x`)).toBe('invalid_exact_near_intents_token_invalid');
    expect(tokenProblem('secret', payment, '/resource', 'junk')).toBe('invalid_exact_near_intents_token_invalid');
    expect(tokenProblem('secret', payment, '/resource', token, (later + 1) * 1000)).toBe('invalid_exact_near_intents_token_expired');
  });

  it('is open in test mode, and with real money only when switched on', () => {
    expect(agentApiOpen('simulated', false)).toBe(true);
    expect(agentApiOpen('chain', false)).toBe(false);
    expect(agentApiOpen('chain', true)).toBe(true);
  });

  it('checks a refund address for the chain being paid from', () => {
    expect(validRefundAddress('base', REFUND)).toBe(true);
    expect(validRefundAddress('base', 'agent.near')).toBe(false);
    expect(validRefundAddress('near', 'agent.near')).toBe(true);
    expect(validRefundAddress('near', REFUND.toUpperCase())).toBe(false);
    expect(validRefundAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });
});
