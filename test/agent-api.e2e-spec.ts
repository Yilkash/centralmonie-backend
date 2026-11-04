import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AgentApiService, agentApiOpen, validRefundAddress } from '../src/agent-api/agent-api.service';
import { CrossChain, CrossChainRequest, CrossChainState } from '../src/agent-api/cross-chain';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import { SwitchesService } from '../src/ops/switches.service';
import { AgentPayout, BankLookup, ExchangeRates, PaymentProvider, PaymentRequest, PaymentState } from '../src/providers/providers';

const DATABASE_URL = process.env.DATABASE_URL!;
const REFUND = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';
const REQUEST = { amount_naira: 5000, bank_name: 'OPay', account_number: '8031234568', pay_from: 'near', refund_to: 'agent.near' };

class FakeCrossChain extends CrossChain {
  state: CrossChainState = { status: 'waiting', transactions: [] };
  quotes: CrossChainRequest[] = [];
  failNext = 0;
  async priceCheck(request: CrossChainRequest) {
    return { depositAddress: null, payInMinor: request.usdcMinor + 2_400 };
  }
  async quote(request: CrossChainRequest) {
    if (this.failNext-- > 0) throw new Error('secret detail from the partner');
    this.quotes.push(request);
    return { depositAddress: '0xdeposit', payInMinor: request.usdcMinor + 2_400 };
  }
  async status() {
    return this.state;
  }
}

class FakePayout extends AgentPayout {
  deposits: PaymentRequest[] = [];
  state: PaymentState = { state: 'pending' };
  destinationKobo: number | null = null;
  async deposit(request: PaymentRequest) {
    this.deposits.push(request);
    return { address: '0xswitch', usdcMinor: request.usdcMinor, destinationKobo: this.destinationKobo ?? request.amountKobo };
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

describe('Agent API', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let agents: AgentApiService;
  const crossChain = new FakeCrossChain();
  const payout = new FakePayout();
  const banks = new FakeBanks();
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
    crossChain.state = { status: 'waiting', transactions: [] };
    crossChain.quotes = [];
    crossChain.failNext = 0;
    payout.deposits = [];
    payout.state = { state: 'pending' };
    payout.destinationKobo = null;
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
      const big = await agents.createKey('Big', 9_000_000);
      const first = (await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 4_900_000 }, big.key)).json();
      await call('POST', '/v1/agent/payments', { quote_id: first.id }, big.key);
      const response = await call('POST', '/v1/agent/quotes', { ...REQUEST, amount_naira: 200_000 }, big.key);
      expect(response.json().code).toBe('paused');
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
      await pool.query(`update agent_payments set deposit_deadline = now() - interval '1 minute'`);
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
      await pool.query(`update agent_payments set status = 'creating', updated_at = now() - interval '5 minutes' where id = $1`, [stuck.id]);
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
