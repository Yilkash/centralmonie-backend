import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { createAdapter, configureApp } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import { NairaDepositsService } from '../src/deposits/deposits.service';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { NairaOnramp, OnrampState } from '../src/providers/providers';

const DATABASE_URL = process.env.DATABASE_URL!;
const WALLET = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (!['alice', 'bob'].includes(token)) throw new InvalidIdentityError('bad');
    return { subject: `did:privy:${token}`, email: null, walletAddress: token === 'alice' ? WALLET : null };
  }
}

class FakeOnramp extends NairaOnramp {
  state: OnrampState = 'waiting';
  orders = 0;
  expiresAt: string | null = new Date(Date.now() + 30 * 60_000).toISOString();
  async nairaOnramp(input: { reference: string; amountKobo: number; walletAddress: string }) {
    this.orders += 1;
    return { reference: input.reference, amountKobo: input.amountKobo, usdcMinor: 1_441_161, rate: '1387.77', bankName: 'Safehaven', accountNumber: '6010681891', accountName: 'Checkout', expiresAt: this.expiresAt };
  }
  async onrampState() { return this.state; }
  async onrampTerms() { return { nairaPerUsdc: 1387.77, minimumKobo: 150_000 }; }
}

describe('naira deposits', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let service: NairaDepositsService;
  const partner = new FakeOnramp();
  const call = (method: 'GET' | 'POST', url: string, token: string, body?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  const notices = async () => (await pool.query(`select content from chat_messages where role = 'assistant' order by created_at`)).rows.map((row) => row.content as string);

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IdentityProvider).useClass(FakeIdentity)
      .overrideProvider(NairaOnramp).useValue(partner)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(NairaDepositsService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    partner.state = 'waiting';
    partner.orders = 0;
    partner.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await call('GET', '/v1/me', 'alice');
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('gives a bank account, the exact amount and an expiry, and keeps one account while it waits', async () => {
    const first = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).json().deposit;
    expect(first).toMatchObject({ status: 'waiting', amount_naira: 2000, account_number: '6010681891', usdc: '1.44 USDC' });
    expect(new Date(first.expires_at).getTime()).toBeGreaterThan(Date.now());
    const again = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 5000 })).json().deposit;
    expect(again.id).toBe(first.id);
    expect(partner.orders).toBe(1);
  });

  it('refuses amounts outside the limits, and an order with no deadline', async () => {
    expect((await call('POST', '/v1/deposits', 'alice', { amount_naira: 1000 })).statusCode).toBe(422);
    expect((await call('POST', '/v1/deposits', 'alice', { amount_naira: 600000 })).statusCode).toBe(422);
    expect((await call('POST', '/v1/deposits', 'alice', { amount_naira: 20.5 })).statusCode).toBe(400);
    partner.expiresAt = null;
    expect((await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).statusCode).toBe(422);
  });

  it('tells the user when the naira lands and when the deposit completes, once each', async () => {
    await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 });
    partner.state = 'processing';
    await service.reconcile();
    await service.reconcile();
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.status).toBe('processing');
    partner.state = 'completed';
    await service.reconcile();
    await service.reconcile();
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.status).toBe('completed');
    const said = await notices();
    expect(said.filter((text) => text.includes('We have received'))).toHaveLength(1);
    expect(said.filter((text) => text.includes('is complete'))).toHaveLength(1);
  });

  it('expires at the deadline, but still credits a transfer that arrives late', async () => {
    const { id } = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).json().deposit;
    await pool.query(`update naira_deposits set expires_at = now() - interval '1 minute' where id = $1`, [id]);
    await service.reconcile();
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.status).toBe('expired');
    partner.state = 'completed';
    await service.reconcile();
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.status).toBe('completed');
  });

  it('says nothing when the partner cannot be read or uses an unknown word', async () => {
    await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 });
    partner.state = 'unknown';
    await service.reconcile();
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.status).toBe('waiting');
    expect(await notices()).toHaveLength(0);
  });

  it('lets a person close one and start another, and keeps deposits private', async () => {
    const { id } = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).json().deposit;
    expect((await call('POST', `/v1/deposits/${id}/close`, 'bob')).statusCode).toBe(404);
    expect((await call('GET', '/v1/deposits/current', 'bob')).json().deposit).toBeNull();
    expect((await call('POST', `/v1/deposits/${id}/close`, 'alice')).statusCode).toBe(200);
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit).toBeNull();
    const next = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 3000 })).json().deposit;
    expect(next.id).not.toBe(id);
  });

  it('reads one deposit by its id, for its owner only', async () => {
    const { id } = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).json().deposit;
    expect((await call('GET', `/v1/deposits/${id}`, 'alice')).json().deposit.id).toBe(id);
    expect((await call('GET', `/v1/deposits/${id}`, 'bob')).json().deposit).toBeNull();
  });

  it('remembers that the user has sent the money, and shows it as on its way', async () => {
    const { id } = (await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).json().deposit;
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.user_sent).toBe(false);
    expect((await call('GET', '/v1/wallet', 'alice')).json().deposit_on_the_way).toBeNull();
    expect((await call('POST', `/v1/deposits/${id}/sent`, 'bob')).statusCode).toBe(404);
    expect((await call('POST', `/v1/deposits/${id}/sent`, 'alice')).statusCode).toBe(200);
    expect((await call('GET', '/v1/deposits/current', 'alice')).json().deposit.user_sent).toBe(true);
    expect((await call('GET', '/v1/wallet', 'alice')).json().deposit_on_the_way).toBe('₦2,000');
    partner.state = 'completed';
    await service.reconcile();
    expect((await call('GET', '/v1/wallet', 'alice')).json().deposit_on_the_way).toBeNull();
    // The wallet summary also reads the balance from a public test network, which can be slow.
  }, 60000);

  it('needs a wallet, and stops when paused', async () => {
    await call('GET', '/v1/me', 'bob');
    expect((await call('POST', '/v1/deposits', 'bob', { amount_naira: 2000 })).statusCode).toBe(422);
    await pool.query(`insert into op_switches (name, paused) values ('deposits', true)`);
    expect((await call('POST', '/v1/deposits', 'alice', { amount_naira: 2000 })).statusCode).toBe(503);
    await pool.query(`delete from op_switches where name = 'deposits'`);
  });
});
