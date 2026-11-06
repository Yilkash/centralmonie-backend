import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { CrossChain, CrossChainState, DepositRequest } from '../src/agent-api/cross-chain';
import { createAdapter, configureApp } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import { ChainDepositsService } from '../src/deposits/chain-deposits.service';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';

const DATABASE_URL = process.env.DATABASE_URL!;
const WALLET = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';
const MY_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const MY_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (!['alice', 'bob'].includes(token)) throw new InvalidIdentityError('bad');
    return { subject: `did:privy:${token}`, email: null, walletAddress: token === 'alice' ? WALLET : null };
  }
}

class FakeRoute extends CrossChain {
  asked: DepositRequest[] = [];
  state: CrossChainState = { status: 'waiting', transactions: [] };
  refuse: string | null = null;
  async priceCheck(): Promise<never> { throw new Error('unused'); }
  async quote(): Promise<never> { throw new Error('unused'); }
  async sendFromBase(): Promise<never> { throw new Error('unused'); }
  async status() { return this.state; }
  override async depositToBase(request: DepositRequest) {
    if (this.refuse) throw new Error(this.refuse);
    this.asked.push(request);
    return { depositAddress: `deposit-${this.asked.length}`, receiverMinor: request.amountMinor - 120_000, seconds: 90 };
  }
}

describe('deposits from other networks', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let service: ChainDepositsService;
  const route = new FakeRoute();
  const call = (method: 'GET' | 'POST', url: string, token: string, body?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  const start = (body: object, token = 'alice') => call('POST', '/v1/chain-deposits', token, body);
  const notices = async () => (await pool.query(`select content from chat_messages where role = 'assistant' order by created_at`)).rows.map((row) => row.content as string);

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IdentityProvider).useClass(FakeIdentity)
      .overrideProvider(CrossChain).useValue(route)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(ChainDepositsService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    route.asked = [];
    route.state = { status: 'waiting', transactions: [] };
    route.refuse = null;
    await call('GET', '/v1/me', 'alice');
    await call('GET', '/v1/me', 'bob');
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('gives a one-time address that delivers USDC to the wallet on Base, refunding on the network it came from', async () => {
    const response = await start({ pay_from: 'polygon', amount: '10', refund_to: MY_EVM });
    expect(response.statusCode).toBe(200);
    expect(response.json().deposit).toMatchObject({ status: 'waiting', network: 'Polygon', token: 'USDC', send: '10.00', you_get: '9.88 USDC', deposit_address: 'deposit-1', refund_to: MY_EVM });
    expect(route.asked[0]).toMatchObject({ payFrom: 'polygon', payToken: 'USDC', amountMinor: 10_000_000, recipient: WALLET, refundTo: MY_EVM });
    expect(new Date(response.json().deposit.deadline).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('remembers the refund address once for every 0x network, and once for Tron', async () => {
    await start({ pay_from: 'arbitrum', amount: '5', refund_to: MY_EVM });
    await start({ pay_from: 'tron', amount: '5', refund_to: MY_TRON });
    const overview = (await call('GET', '/v1/chain-deposits', 'alice')).json();
    expect(overview.refund_addresses).toEqual({ evm: MY_EVM, tron: MY_TRON });
    expect(overview.networks.find((item: { id: string }) => item.id === 'bsc')).toMatchObject({ name: 'BNB Chain', family: 'evm', tokens: ['USDC', 'USDT'] });
    expect(overview.networks.find((item: { id: string }) => item.id === 'base')).toBeUndefined();
    expect(overview.deposits).toHaveLength(2);
    // Another user sees none of it.
    expect((await call('GET', '/v1/chain-deposits', 'bob')).json()).toMatchObject({ refund_addresses: {}, deposits: [] });
  });

  it('takes USDT from Tron without asking which token', async () => {
    const deposit = (await start({ pay_from: 'tron', pay_token: 'USDC', amount: '20', refund_to: MY_TRON })).json().deposit;
    expect(deposit).toMatchObject({ token: 'USDT', network: 'Tron' });
    expect(route.asked[0]!.payToken).toBe('USDT');
  });

  it.each([
    ['the 10kobo wallet itself as the refund address, which only exists on Base', { pay_from: 'polygon', amount: '5', refund_to: WALLET }, 'only exists on Base'],
    ['a refund address from another network', { pay_from: 'tron', amount: '5', refund_to: MY_EVM }, 'not a valid Tron address'],
    ['Base, which needs no route', { pay_from: 'base', amount: '5', refund_to: MY_EVM }, 'send to your wallet address directly'],
    ['Stellar, which NEAR Intents will not take yet', { pay_from: 'stellar', amount: '5', refund_to: MY_EVM }, 'Deposits can come from'],
    ['less than 1', { pay_from: 'polygon', amount: '0.5', refund_to: MY_EVM }, 'smallest deposit'],
    ['a made-up amount', { pay_from: 'polygon', amount: 'ten', refund_to: MY_EVM }, 'Enter an amount'],
    ['USDT where there is none', { pay_from: 'polygon', pay_token: 'USDT', amount: '5', refund_to: MY_EVM }, 'USDT cannot be sent from Polygon'],
  ])('refuses %s', async (_name, body, message) => {
    const response = await start(body);
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain(message);
    expect(route.asked).toHaveLength(0);
  });

  it('says plainly when NEAR Intents has a minimum, and sets nothing up', async () => {
    route.refuse = 'Temporary swap limits: minimum swap amount is $1,000';
    const response = await start({ pay_from: 'bsc', amount: '5', refund_to: MY_EVM });
    expect(response.json().message).toBe('Deposits from BNB Chain start at $1,000 for the moment. Nothing was set up.');
    expect((await call('GET', '/v1/chain-deposits', 'alice')).json().deposits).toHaveLength(0);
  });

  it('follows the deposit and tells the user once when the USDC lands', async () => {
    const deposit = (await start({ pay_from: 'tron', amount: '20', refund_to: MY_TRON })).json().deposit;
    route.state = { status: 'moving', transactions: ['tron-hash'] };
    await service.reconcile();
    expect((await call('GET', `/v1/chain-deposits/${deposit.id}`, 'alice')).json().deposit.status).toBe('moving');
    route.state = { status: 'delivered', transactions: ['tron-hash', '0x' + 'cd'.repeat(32)], receivedMinor: 19_120_000 };
    await service.reconcile();
    await service.reconcile();
    expect((await call('GET', `/v1/chain-deposits/${deposit.id}`, 'alice')).json().deposit).toMatchObject({ status: 'delivered', received: '19.12 USDC', delivery_tx_url: `https://basescan.org/tx/0x${'cd'.repeat(32)}` });
    expect((await notices()).filter((text) => text.includes('arrived'))).toEqual(['20.00 USDT from Tron arrived: 19.12 USDC added to your wallet.']);
    expect((await call('GET', `/v1/chain-deposits/${deposit.id}`, 'bob')).statusCode).toBe(404);
  });

  it('says when a deposit was refunded, and closes one where nothing came', async () => {
    const refunded = (await start({ pay_from: 'polygon', amount: '5', refund_to: MY_EVM })).json().deposit;
    route.state = { status: 'refunded', transactions: [] };
    await service.reconcile();
    expect((await call('GET', `/v1/chain-deposits/${refunded.id}`, 'alice')).json().deposit.status).toBe('refunded');
    expect((await notices()).some((text) => text.includes('sent back to your Polygon address'))).toBe(true);

    const idle = (await start({ pay_from: 'polygon', amount: '5', refund_to: MY_EVM })).json().deposit;
    route.state = { status: 'waiting', transactions: [] };
    await pool.query(`update chain_deposits set deadline = now() - interval '2 hours' where id = $1`, [idle.id]);
    await service.reconcile();
    expect((await call('GET', `/v1/chain-deposits/${idle.id}`, 'alice')).json().deposit.status).toBe('expired');
  });
});
