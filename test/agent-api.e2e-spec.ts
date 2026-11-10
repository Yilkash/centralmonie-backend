import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AgentApiService, agentApiOpen, ipGroup, KEYLESS_KEY_ID, maskName, paymentsToCsv, validRefundAddress } from '../src/agent-api/agent-api.service';
import { NearExactFacilitator, NearExactPayload, NearExactRequirements, NearRelayer, SignedDelegate, USDC_ON_NEAR } from '../src/agent-api/near-relay';
import { PayLinksService, presentOwnLink } from '../src/agent-api/pay-links.service';
import { MerchantService, signNotice } from '../src/agent-api/merchant.service';
import { operationToken, tokenProblem } from '../src/agent-api/x402';
import { AgentPayment, User } from '../src/database/schema';
import { CrossChain, CrossChainRequest, CrossChainState } from '../src/agent-api/cross-chain';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import { Chain } from '../src/chain/chain.service';
import { Transfer } from '../src/chain/chain';
import { SwitchesService } from '../src/ops/switches.service';
import { WalletService } from '../src/wallet/wallet.service';
import { AgentPayout, BankLookup, ExchangeRates, NairaOnramp, OnrampState, PaymentProvider, PaymentRequest, PaymentState } from '../src/providers/providers';

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
  /** Fails this many times, then works. */
  blips = 0;
  asked = 0;
  async accountName(_bank: string, accountNumber: string) {
    this.asked++;
    if (this.down) throw new Error('bank down');
    if (this.blips-- > 0) throw new Error('connection dropped');
    return accountNumber.endsWith('0000') ? null : 'Ada Bello';
  }
}

class FakeOnramp extends NairaOnramp {
  state: OnrampState = 'waiting';
  orders: { reference: string; amountKobo: number; walletAddress: string }[] = [];
  failNext = 0;
  expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
  async nairaOnramp(input: { reference: string; amountKobo: number; walletAddress: string }) {
    if (this.failNext-- > 0) throw new Error('partner down');
    this.orders.push(input);
    return { reference: input.reference, amountKobo: input.amountKobo, usdcMinor: 3_602_305, rate: '1388', bankName: 'Safehaven', accountNumber: '6010681891', accountName: '10kobo Customer', expiresAt: this.expiresAt() };
  }
  async onrampState() {
    return this.state;
  }
  async onrampTerms() {
    return { nairaPerUsdc: 1388, minimumKobo: 150_000 };
  }
}

class FakeRelayer extends NearRelayer {
  balance: bigint | null = 100_000_000n;
  async usdcBalance() {
    return this.balance;
  }
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

class FakeNearExact extends NearExactFacilitator {
  verified: { payload: NearExactPayload; requirements: NearExactRequirements }[] = [];
  settled: { payload: NearExactPayload; requirements: NearExactRequirements }[] = [];
  valid = true;
  settles = true;
  async verify(payload: NearExactPayload, requirements: NearExactRequirements) {
    this.verified.push({ payload, requirements });
    // Like the official one: the signed amount and recipient must match what we require.
    const matches = payload.accepted.amount === requirements.amount && payload.accepted.payTo === requirements.payTo;
    return this.valid && matches ? { isValid: true, payer: 'agent.near' } : { isValid: false, invalidReason: 'invalid_exact_near_amount_mismatch' };
  }
  async settle(payload: NearExactPayload, requirements: NearExactRequirements) {
    this.settled.push({ payload, requirements });
    return this.settles ? { success: true, transaction: 'NearTxHash111', network: 'near:mainnet', payer: 'agent.near' } : { success: false, errorReason: 'transaction_failed', transaction: '', network: 'near:mainnet' };
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
  const nearExact = new FakeNearExact();
  const onramp = new FakeOnramp();
  // USDC that reached receivers on Base, as the chain reader would find it.
  let deliveries: Transfer[] = [];
  const delivered = (to: string, value: bigint, txHash: string) =>
    deliveries.push({ txHash, logIndex: 0, block: 1000, from: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', to, value } as Transfer);
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
      .overrideProvider(NearExactFacilitator).useValue(nearExact)
      .overrideProvider(NairaOnramp).useValue(onramp)
      .overrideProvider(ExchangeRates).useValue({ nairaPerUsdc: async () => 1400 })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    agents = app.get(AgentApiService, { strict: false });
    const chain = app.get(Chain, { strict: false });
    jest.spyOn(chain, 'latestBlock').mockImplementation(async () => 1000);
    jest.spyOn(chain, 'transfers').mockImplementation(async (filter, from, to) =>
      deliveries.filter((item) => item.block >= from && item.block <= to && (filter.to ?? []).some((address) => address.toLowerCase() === item.to.toLowerCase())),
    );
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
    onramp.state = 'waiting';
    onramp.orders = [];
    onramp.failNext = 0;
    deliveries = [];
    (agents as unknown as { searchedTo: Map<string, number> }).searchedTo.clear();
    onramp.expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
    banks.blips = 0;
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
      [{ pay_from: 'stellar' }, 'invalid_request', 400],
      [{ pay_from: 'tron', refund_to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'invalid_refund_address', 400],
      [{ pay_from: 'base', refund_to: 'agent.near' }, 'invalid_refund_address', 400],
      [{ account_number: '8031230000' }, 'account_not_found', 404],
      [{ amount_naira: 25_000 }, 'over_daily_limit', 422],
    ])('refuses %j', async (over, code, statusCode) => {
      const response = await call('POST', '/v1/agent/quotes', { ...REQUEST, ...over });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json().code).toBe(code);
    });

    it('lets a payer on Tron pay without choosing a token, because only USDT goes from there', async () => {
      const body = await quote({ pay_from: 'tron', refund_to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });
      expect(body).toMatchObject({ status: 'quoted', pay_from: 'tron' });
      expect((await pool.query('select pay_token from agent_payments where id = $1', [body.id])).rows[0].pay_token).toBe('USDT');
    });

    it('keeps x402 to the networks it has standard names for', async () => {
      const response = await call('POST', '/v1/agent/x402/pay', { ...REQUEST, pay_from: 'tron', refund_to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('over x402');
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

  describe('x402 exact on NEAR (the official standard)', () => {
    const decode = (value: string | string[] | number | undefined) => JSON.parse(Buffer.from(String(value), 'base64').toString());
    const body = { ...REQUEST, refund_to: 'agent.near' };
    const ask = (signature?: object, token: string = key) =>
      app.inject({ method: 'POST', url: '/v1/agent/x402/pay', headers: { authorization: `Bearer ${token}`, ...(signature ? { 'payment-signature': Buffer.from(JSON.stringify(signature)).toString('base64') } : {}) }, payload: body });
    const transfer = (to: string, amount: string, sender = 'agent.near'): SignedDelegate => ({
      senderId: sender,
      receiverId: USDC_ON_NEAR,
      actions: [{ method: 'ft_transfer', args: JSON.stringify({ receiver_id: to, amount }), deposit: 1n, gas: 30_000_000_000_000n }],
    });
    // What the official @x402/near client sends back: the offer it chose, and the signed transfer.
    const standard = (accepted: object) => ({ x402Version: 2, resource: { url: 'http://localhost/v1/agent/x402/pay' }, accepted, payload: { signedDelegateAction: 'c2lnbmVk' } });
    const offered = async () => {
      const first = await ask();
      return { first, offer: decode(first.headers['payment-required']).accepts[0], id: first.json().payment.id as string };
    };

    beforeEach(() => {
      nearExact.verified = [];
      nearExact.settled = [];
      nearExact.valid = true;
      nearExact.settles = true;
      relayer.balance = 100_000_000n;
      relayer.registered = [];
    });

    it('offers the standard exact payment on NEAR first: the USDC contract, the exact amount, its own deposit account', async () => {
      const { first, offer } = await offered();
      expect(first.statusCode).toBe(402);
      expect(offer).toEqual({ scheme: 'exact', network: 'near:mainnet', amount: '3573829', asset: USDC_ON_NEAR, payTo: '0xdeposit', maxTimeoutSeconds: 300 });
    });

    it('settles when the same request comes back with the signed transfer, and answers 200 with PAYMENT-RESPONSE', async () => {
      const { offer, id } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      const paid = await ask(standard(offer));
      expect(paid.statusCode).toBe(200);
      expect(decode(paid.headers['payment-response'])).toEqual({ success: true, transaction: 'NearTxHash111', network: 'near:mainnet', payer: 'agent.near' });
      // The requirements come from our record, and the deposit account was registered for USDC first.
      expect(nearExact.settled[0]!.requirements).toEqual(offer);
      expect(relayer.registered).toContain('0xdeposit');
      expect((await status(id)).id).toBe(id);
      const row = (await pool.query('select transactions, relayed_at from agent_payments where id = $1', [id])).rows[0];
      expect(row.transactions).toEqual(['NearTxHash111']);
      expect(row.relayed_at).not.toBeNull();
    });

    it('also settles on the payment\'s own URL', async () => {
      const { offer, id } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      const paid = await app.inject({ method: 'POST', url: `/v1/agent/x402/pay/${id}`, headers: { authorization: `Bearer ${key}`, 'payment-signature': Buffer.from(JSON.stringify(standard(offer))).toString('base64') } });
      expect(paid.statusCode).toBe(200);
    });

    it('settles only once', async () => {
      const { offer } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      expect((await ask(standard(offer))).statusCode).toBe(200);
      expect((await ask(standard(offer))).json().code).toBe('already_relayed');
      expect(nearExact.settled).toHaveLength(1);
    });

    it('never trusts the client: a changed amount fails verification, and a short or wrong transfer is refused first', async () => {
      const { offer } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      const cheaper = await ask(standard({ ...offer, amount: '1' }));
      expect(cheaper.statusCode).toBe(402);
      expect(decode(cheaper.headers['payment-response'])).toMatchObject({ success: false, errorReason: 'invalid_exact_near_amount_mismatch' });
      relayer.delegate = transfer('0xdeposit', '1');
      expect((await ask(standard(offer))).json().code).toBe('relay_refused');
      relayer.delegate = transfer('0xelsewhere', '3573829');
      expect((await ask(standard(offer))).json().code).toBe('relay_refused');
      relayer.delegate = transfer('0xdeposit', '3573829', 'stranger.near');
      expect((await ask(standard(offer))).json().code).toBe('relay_refused');
      expect(nearExact.settled).toHaveLength(0);
    });

    it('spends no NEAR on an account without the USDC', async () => {
      const { offer } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      relayer.balance = 5n;
      expect((await ask(standard(offer))).json().code).toBe('insufficient_funds');
      expect(relayer.registered).toHaveLength(0);
      expect(nearExact.verified).toHaveLength(0);
    });

    it('lets a failed settlement be tried again, as the NEAR nonce stops it landing twice', async () => {
      const { offer } = await offered();
      relayer.delegate = transfer('0xdeposit', '3573829');
      nearExact.settles = false;
      const failed = await ask(standard(offer));
      expect(failed.statusCode).toBe(402);
      expect(decode(failed.headers['payment-response'])).toMatchObject({ success: false, errorReason: 'transaction_failed' });
      nearExact.settles = true;
      expect((await ask(standard(offer))).statusCode).toBe(200);
    });

    it('refuses a payload for a deposit account that is not this key\'s', async () => {
      const { offer } = await offered();
      const other = await agents.createKey('Other NEAR', 20_000);
      expect((await ask(standard(offer), other.key)).json().code).toBe('not_found');
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
      // From NEAR the first answer already names the deposit account: the standard `exact` offer first, the draft second.
      expect(decode(first.headers['payment-required']).accepts[0]).toMatchObject({ scheme: 'exact', network: 'near:mainnet', asset: USDC_ON_NEAR, payTo: '0xdeposit', maxTimeoutSeconds: 300 });
      expect(decode(first.headers['payment-required']).accepts[1].extra.operationToken).toMatch(/^k1\./);
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
      // From NEAR the first answer accepts, so the cap is checked there, even for requests arriving together.
      const answers = await Promise.all(['8031234005', '8031234006', '8031234007'].map((account_number) => start({ amount_naira: 50_000, account_number, refund_to: 'e.near' })));
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

    it('never tells a shop an invoice ended while its money is still moving, and always sends paid', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      await payLink(invoice.id);
      crossChain.state = { status: 'moving', transactions: ['0xa'] };
      expect((await open(invoice.id)).json().payment.status).toBe('processing');
      await pool.query(`update pay_links set expires_at = now() - interval '1 minute' where id = $1`, [invoice.id]);
      await merchants.reconcile();
      expect(notices).toHaveLength(0);
      expect((await shop('GET', `/v1/merchant/invoices/${invoice.id}`)).json().status).toBe('being_paid');
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      expect((await open(invoice.id)).json().paid).toBe(true);
      await merchants.reconcile();
      expect(notices.map((notice) => JSON.parse(notice.body).type)).toEqual(['invoice.paid']);
    });

    it('still sends paid when money sent at the last moment lands after the shop cancelled', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      const payment = (await payLink(invoice.id)).json().payment;
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '16 minutes' where id = $1`, [payment.id]);
      expect((await open(invoice.id)).json().payment.status).toBe('expired');
      expect((await shop('POST', `/v1/merchant/invoices/${invoice.id}/cancel`)).json().status).toBe('cancelled');
      await merchants.reconcile();
      crossChain.state = { status: 'delivered', transactions: ['0xa'] };
      payout.state = { state: 'completed' };
      await agents.reconcile();
      await agents.reconcile();
      await merchants.reconcile();
      expect(notices.map((notice) => JSON.parse(notice.body).type)).toEqual(['invoice.cancelled', 'invoice.paid']);
    });

    it('voids an unaccepted quote when the invoice is cancelled, so it cannot be accepted afterwards', async () => {
      const invoice = (await shop('POST', '/v1/merchant/invoices', ORDER)).json();
      const quote = await agents.quote(await agents.keylessKey(), { amountNaira: 4000, bankName: 'OPay', accountNumber: '8031234568', payFrom: 'arbitrum', refundTo: REFUND });
      await pool.query('update pay_links set payment_id = $1 where id = $2', [quote.id, invoice.id]);
      expect((await shop('POST', `/v1/merchant/invoices/${invoice.id}/cancel`)).json().status).toBe('cancelled');
      expect((await pool.query('select status from agent_payments where id = $1', [quote.id])).rows[0].status).toBe('expired');
      await expect(agents.accept(await agents.keylessKey(), quote.id)).rejects.toThrow('expired');
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

  describe('paying in naira by bank transfer', () => {
    const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    let links: PayLinksService;
    const user = { id: '', walletAddress: WALLET } as unknown as User;
    const open = (id: string) => app.inject({ method: 'GET', url: `/v1/public/pay-links/${id}` });
    const payNaira = (id: string, ip = '10.9.9.9') => app.inject({ method: 'POST', url: `/v1/public/pay-links/${id}/pay`, remoteAddress: ip, payload: { pay_from: 'naira' } });
    const usdcInvoice = () => links.create(user, { amountNaira: 5000, usdcAddress: WALLET, note: 'Design work' });

    beforeEach(async () => {
      links = app.get(PayLinksService, { strict: false });
      await pool.query('TRUNCATE users CASCADE');
      user.id = (await pool.query(`insert into users (provider_subject, wallet_address) values ('did:privy:naira', $1) returning id`, [WALLET])).rows[0].id;
    });

    it('lets a busy payer page reuse a check from a few seconds ago instead of asking the partner again', async () => {
      const due = (agents as unknown as { dueForCheck: (id: string, now?: number) => boolean }).dueForCheck.bind(agents);
      const config = (agents as unknown as { config: { get: (name: string) => unknown } }).config;
      const real = config.get.bind(config);
      config.get = (name: string) => (name === 'PAYMENT_RECHECK_MS' ? 4000 : real(name));
      try {
        expect(due('p-1', 1_000_000)).toBe(true);
        expect(due('p-1', 1_002_000)).toBe(false);
        expect(due('p-2', 1_002_000)).toBe(true);
        expect(due('p-1', 1_004_500)).toBe(true);
      } finally {
        config.get = real;
      }
    });

    it('lets a payer transfer naira when the receiver gets USDC on Base, and the partner sends the USDC straight there', async () => {
      const link = await usdcInvoice();
      expect((await open(link.id)).json()).toMatchObject({ naira_available: true, receives: 'USDC on Base' });
      const response = await payNaira(link.id);
      expect(response.statusCode).toBe(200);
      const payment = response.json().payment;
      expect(payment).toMatchObject({ status: 'awaiting_deposit', pay_from: 'naira', deposit_address: null, receiver_gets_usdc: '3.60', naira_account: { bank_name: 'Safehaven', account_number: '6010681891', account_name: '10kobo Customer', amount_naira: 5000 } });
      expect(new Date(payment.deposit_deadline).getTime()).toBeGreaterThan(Date.now());
      expect(onramp.orders).toEqual([{ reference: payment.id, amountKobo: 500_000, walletAddress: WALLET }]);
      expect(crossChain.quotes).toHaveLength(0);
      expect(payout.deposits).toHaveLength(0);
      // A refresh gives the same account, so one payer never gets two.
      expect((await payNaira(link.id)).json().payment.id).toBe(payment.id);
      expect(onramp.orders).toHaveLength(1);

      onramp.state = 'processing';
      expect((await open(link.id)).json().payment).toMatchObject({ status: 'processing', naira_account: null });
      onramp.state = 'completed';
      // The partner's word is not enough: until the USDC shows up on Base, it is still on its way.
      expect((await open(link.id)).json()).toMatchObject({ paid: false, payment: { status: 'processing' } });
      // A little under the quote, as the first real payment was (1.157101 for 1.157106).
      delivered(WALLET, 3_602_300n, '0x' + 'ab'.repeat(32));
      const paid = (await open(link.id)).json();
      expect(paid).toMatchObject({ paid: true, open: false, payment: { status: 'paid', links: [{ label: 'Delivery on Base', url: `https://basescan.org/tx/0x${'ab'.repeat(32)}` }] } });
      expect((await payNaira(link.id)).json().code).toBe('already_paid');
    });

    it('gives each payer network its own naira allowance, so one person cannot block everyone', async () => {
      const big = () => links.create(user, { amountNaira: 50_000, usdcAddress: WALLET });
      expect((await payNaira((await big()).id, '10.1.1.1')).statusCode).toBe(200);
      expect((await payNaira((await big()).id, '10.1.1.1')).statusCode).toBe(200);
      const third = await payNaira((await big()).id, '10.1.1.1');
      expect(third.json().code).toBe('over_wallet_limit');
      // Another network can still pay, to a receiver that has not had its own day's limit.
      const other = await links.create(user, { amountNaira: 50_000, usdcAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' });
      const fresh = await payNaira(other.id, '10.2.2.2');
      expect(fresh.json().code ?? fresh.statusCode).toBe(200);
    });

    it('does not offer naira when the receiver gets naira, or the amount is too small', async () => {
      const bank = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      expect((await open(bank.id)).json().naira_available).toBe(false);
      const refused = await payNaira(bank.id);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe('naira_unavailable');
      const small = await links.create(user, { amountNaira: 1000, usdcAddress: WALLET });
      expect((await payNaira(small.id)).json()).toMatchObject({ code: 'below_minimum', message: 'The smallest naira payment is ₦1,500.' });
      expect(onramp.orders).toHaveLength(0);
    });

    it('still needs a refund address for crypto, but not for naira', async () => {
      const link = await usdcInvoice();
      const missing = await app.inject({ method: 'POST', url: `/v1/public/pay-links/${link.id}/pay`, remoteAddress: '10.9.9.8', payload: { pay_from: 'base' } });
      expect(missing.statusCode).toBe(400);
    });

    it('stops showing the bank account when its time is up, waits for a late transfer, then lets the payer start again', async () => {
      const link = await usdcInvoice();
      const first = (await payNaira(link.id)).json().payment;
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '1 second' where id = $1`, [first.id]);
      expect((await open(link.id)).json().payment).toMatchObject({ status: 'checking', naira_account: null });
      expect((await payNaira(link.id)).json().code).toBe('checking_last_payment');
      onramp.state = 'expired';
      expect((await open(link.id)).json().payment).toMatchObject({ status: 'expired' });
      onramp.state = 'waiting';
      const second = (await payNaira(link.id)).json().payment;
      expect(second.id).not.toBe(first.id);
      expect(second.naira_account.account_number).toBe('6010681891');
    });

    it('says nothing was paid when the partner cannot give an account, and works on the next try', async () => {
      const link = await usdcInvoice();
      onramp.failNext = 1;
      const failed = await payNaira(link.id);
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ code: 'setup_failed', message: 'We could not set up a bank transfer just now. Nothing was paid. Please try again.' });
      expect((await payNaira(link.id)).json().payment.status).toBe('awaiting_deposit');
    });

    it('does not count a transfer that is too small, or one already counted for another payment', async () => {
      const first = (await payNaira((await usdcInvoice()).id)).json().payment;
      const second = (await payNaira((await usdcInvoice()).id, '10.4.4.4')).json().payment;
      onramp.state = 'completed';
      delivered(WALLET, 3_602_305n, '0x' + '01'.repeat(32));
      await agents.reconcile();
      const rows = async () => (await pool.query('select id, status, transactions from agent_payments where id = any($1) order by created_at', [[first.id, second.id]])).rows;
      // One transfer pays one payment, never two.
      expect((await rows()).map((row) => row.status).sort()).toEqual(['paid', 'processing']);
      delivered(WALLET, 3_000_000n, '0x' + '02'.repeat(32));
      await agents.reconcile();
      expect((await rows()).map((row) => row.status).sort()).toEqual(['paid', 'processing']);
      delivered(WALLET, 3_590_000n, '0x' + '03'.repeat(32));
      await agents.reconcile();
      expect((await rows()).map((row) => row.transactions[0]).sort()).toEqual(['0x' + '01'.repeat(32), '0x' + '03'.repeat(32)]);
    });

    it('asks a person to look when the partner says sent but no USDC shows up on Base', async () => {
      const payment = (await payNaira((await usdcInvoice()).id)).json().payment;
      onramp.state = 'completed';
      await agents.reconcile();
      expect((await pool.query('select status from agent_payments where id = $1', [payment.id])).rows[0].status).toBe('processing');
      await pool.query(`update agent_payments set updated_at = now() - interval '21 minutes' where id = $1`, [payment.id]);
      await agents.reconcile();
      const row = (await pool.query('select status, failure_reason from agent_payments where id = $1', [payment.id])).rows[0];
      expect(row).toMatchObject({ status: 'needs_support', failure_reason: expect.stringContaining('has not shown up on Base') });
    });

    it('hands a failed transfer to a person instead of guessing', async () => {
      const link = await usdcInvoice();
      const payment = (await payNaira(link.id)).json().payment;
      onramp.state = 'failed';
      await agents.reconcile();
      const row = (await pool.query('select status, failure_reason from agent_payments where id = $1', [payment.id])).rows[0];
      expect(row).toMatchObject({ status: 'needs_support', failure_reason: expect.stringContaining('Do not pay again') });
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

    describe('reusable payment links', () => {
      const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
      const view = (id: string) => app.inject({ method: 'GET', url: `/v1/public/product-links/${id}` });
      const checkout = (id: string) => app.inject({ method: 'POST', url: `/v1/public/product-links/${id}/checkout` });

      it('one link, many customers: each Pay makes its own invoice at the fixed price, paying the owner', async () => {
        const product = await links.createProduct(user, { title: 'Jollof pack', amountNaira: 3500, bankName: 'OPay', accountNumber: '8031234568' });
        const page = await view(product.id);
        expect(page.statusCode).toBe(200);
        expect(page.json()).toMatchObject({ title: 'Jollof pack', amount_naira: 3500, to: 'Ada Bello', receives: 'naira, OPay ****4568', open: true });
        expect(page.json().url).toContain(`/p/${product.id}`);
        expect(page.body).not.toContain('8031234568');
        const first = (await checkout(product.id)).json();
        const second = (await checkout(product.id)).json();
        expect(first.invoice_id).not.toBe(second.invoice_id);
        expect(first.url).toContain(`/pay/${first.invoice_id}`);
        const invoice = (await open(first.invoice_id)).json();
        expect(invoice).toMatchObject({ amount_naira: 3500, to: 'Ada Bello', note: 'Jollof pack', open: true, paid: false });
        const rows = (await pool.query('select user_id, product_link_id, amount_kobo, account_number from pay_links where product_link_id = $1', [product.id])).rows;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.user_id === user.id && row.amount_kobo === '350000' && row.account_number === '8031234568')).toBe(true);
      });

      it('checks the payout once, when the link is made, never when a customer pays', async () => {
        await expect(links.createProduct(user, { title: 'Bad', amountNaira: 1000, bankName: 'OPay', accountNumber: '8031230000' })).rejects.toThrow('could not find that account');
        const product = await links.createProduct(user, { title: 'Design', amountNaira: 1000, usdcAddress: WALLET });
        expect((await view(product.id)).json()).toMatchObject({ to: WALLET, receives: 'USDC on Base' });
        const lookups = banks.asked;
        await checkout(product.id);
        expect(banks.asked).toBe(lookups);
      });

      it('refuses a bad name or price, and caps how many a seller keeps live', async () => {
        await expect(links.createProduct(user, { title: 'x', amountNaira: 1000, usdcAddress: WALLET })).rejects.toThrow('2 to 80');
        await expect(links.createProduct(user, { title: 'Too much', amountNaira: 50_001, usdcAddress: WALLET })).rejects.toThrow('The most for one payment');
        for (let n = 0; n < 20; n++) await links.createProduct(user, { title: `Item ${n}`, amountNaira: 100, usdcAddress: WALLET });
        await expect(links.createProduct(user, { title: 'One more', amountNaira: 100, usdcAddress: WALLET })).rejects.toThrow('20 payment links');
      });

      it('a stopped link makes no more invoices, and only its owner can stop it', async () => {
        const product = await links.createProduct(user, { title: 'Shoes', amountNaira: 2000, usdcAddress: WALLET });
        const stranger = { id: (await pool.query(`insert into users (provider_subject) values ('did:privy:stranger') returning id`)).rows[0].id } as User;
        expect(await links.stopProduct(stranger, product.id)).toBe(false);
        expect(await links.stopProduct(user, product.id)).toBe(true);
        expect((await view(product.id)).json().open).toBe(false);
        expect((await checkout(product.id)).json().code).toBe('link_stopped');
        expect((await view('00000000-0000-4000-8000-000000000999')).statusCode).toBe(404);
      });

      it('counts only paid invoices for the owner', async () => {
        const product = await links.createProduct(user, { title: 'Bag', amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
        const { invoice_id } = (await checkout(product.id)).json();
        await checkout(product.id);
        await payLink(invoice_id);
        crossChain.state = { status: 'delivered', transactions: ['0xa'] };
        payout.state = { state: 'completed' };
        await open(invoice_id);
        await app.get(AgentApiService, { strict: false }).reconcile();
        const listed = await links.listProducts(user);
        expect(listed[0]).toMatchObject({ title: 'Bag', paid_count: 1, stopped: false });
      });

      it('lets the customer type the amount when the seller asks, never below the minimum, and a fixed price stays fixed', async () => {
        const open_ = await links.createProduct(user, { title: 'Lessons', amountNaira: null, minimumNaira: 1000, usdcAddress: WALLET });
        expect((await view(open_.id)).json()).toMatchObject({ amount_naira: null, customer_chooses: true, minimum_naira: 1000 });
        const pay = (id: string, amount?: number) => app.inject({ method: 'POST', url: `/v1/public/product-links/${id}/checkout`, payload: amount === undefined ? {} : { amount_naira: amount } });
        expect((await pay(open_.id)).json().code).toBe('invalid_amount');
        expect((await pay(open_.id, 999)).json().code).toBe('invalid_amount');
        expect((await pay(open_.id, 50_001)).json().code).toBe('over_payment_limit');
        const chosen = (await pay(open_.id, 2500)).json();
        expect((await open(chosen.invoice_id)).json()).toMatchObject({ amount_naira: 2500, note: 'Lessons' });
        const fixed = await links.createProduct(user, { title: 'Pack', amountNaira: 3500, usdcAddress: WALLET });
        const cheaper = (await pay(fixed.id, 1)).json();
        expect((await open(cheaper.invoice_id)).json().amount_naira).toBe(3500);
        expect((await view(fixed.id)).json()).toMatchObject({ amount_naira: 3500, customer_chooses: false, minimum_naira: null });
      });

      it('caps the invoices one link can open in a day', async () => {
        const product = await links.createProduct(user, { title: 'Popular', amountNaira: 100, usdcAddress: WALLET });
        await pool.query(`insert into pay_links (user_id, amount_kobo, bank_name, account_number, account_name, product_link_id, expires_at)
          select $1, 10000, 'Base', $2, $2, $3, now() + interval '1 day' from generate_series(1, 500)`, [user.id, WALLET, product.id]);
        expect((await checkout(product.id)).json().code).toBe('too_many_requests');
      });
    });

    it('shows a payer what they need and no more, and a link needs no sign-in', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568', note: 'Rent' });
      expect(links.url(link)).toContain(`/pay/${link.id}`);
      const response = await open(link.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ amount_naira: 5000, to: 'Ada Bello', account_number: '****4568', note: 'Rent', open: true, paid: false, payment: null });
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

    it('stops offering an address once the time to send has passed, checks for a late arrival, then lets the payer start again', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      const first = (await payLink(link.id)).json().payment;
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '1 second' where id = $1`, [first.id]);
      expect((await open(link.id)).json()).toMatchObject({ open: true, payment: { id: first.id, status: 'checking', deposit_address: null, deposit_deadline: null, failure_reason: null } });
      // Someone who sent at the last moment is not asked to pay again while we look for their money.
      const early = await payLink(link.id);
      expect(early.statusCode).toBe(409);
      expect(early.json().code).toBe('checking_last_payment');
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '16 minutes' where id = $1`, [first.id]);
      expect((await open(link.id)).json().payment).toMatchObject({ id: first.id, status: 'expired', failure_reason: 'No payment arrived in time.' });
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

    it('rides out one dropped connection to the bank check', async () => {
      const link = await links.create(user, { amountNaira: 5000, bankName: 'OPay', accountNumber: '8031234568' });
      banks.blips = 1;
      expect((await payLink(link.id)).json().payment).toMatchObject({ status: 'awaiting_deposit' });
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

    it('shows every caller the full account name, so a payer can be sure who they pay, but never the full number', async () => {
      // Decided 10 Nov 2026: a name cannot move money, and Nigerian banks show it on every transfer. Lookups stay rate-limited.
      const keyless = await app.inject({ method: 'POST', url: '/v1/agent/x402/pay', payload: { ...REQUEST, payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1' } });
      expect(keyless.json().payment.account_name).toBe('Ada Bello');
      expect(keyless.json().payment.account_number).toBe('****4568');
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
      // From NEAR the first answer is the accept, so it is what the per-address limit counts.
      const accept = (n: number) => start(n);
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
    expect(validRefundAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(validRefundAddress('ton', 'UQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fIKLE')).toBe(true);
    expect(validRefundAddress('sui', '0x' + 'ab'.repeat(32))).toBe(true);
    expect(validRefundAddress('polygon', REFUND)).toBe(true);
    expect(validRefundAddress('tron', REFUND)).toBe(false);
  });
});
