import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { applyMigrations } from '../src/database/migrate';
import {
  IdentityProvider,
  IdentityUnavailableError,
  InvalidIdentityError,
  VerifiedIdentity,
} from '../src/identity/identity-provider';

const DATABASE_URL = process.env.DATABASE_URL!;
const WALLET = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';

const tokens: Record<string, VerifiedIdentity> = {
  alice: { subject: 'did:privy:alice', email: 'alice@example.com', walletAddress: WALLET },
  bob: { subject: 'did:privy:bob', email: 'bob@example.com', walletAddress: null },
};

class FakeIdentity extends IdentityProvider {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (token === 'outage') throw new IdentityUnavailableError('down');
    const identity = tokens[token];
    if (!identity) throw new InvalidIdentityError('bad');
    return identity;
  }
}

describe('10kobo API', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  const call = (method: 'GET' | 'POST', url: string, token?: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body } : {}),
    });

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IdentityProvider)
      .useClass(FakeIdentity)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => pool.query('TRUNCATE users CASCADE'));

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('reports health', async () => {
    expect((await call('GET', '/health')).json()).toEqual({ status: 'ok', chain_id: 84532 });
  });

  it.each(['/v1/me', '/v1/chat/messages'])('refuses %s without a valid token', async (url) => {
    expect((await call('GET', url)).statusCode).toBe(401);
    expect((await call('GET', url, 'forged')).statusCode).toBe(401);
  });

  it('answers 503, not 401, while the identity provider is down', async () => {
    expect((await call('GET', '/v1/me', 'outage')).statusCode).toBe(503);
  });

  it('creates the user once, with their wallet', async () => {
    const first = (await call('GET', '/v1/me', 'alice')).json();
    const second = (await call('GET', '/v1/me', 'alice')).json();
    expect(first).toMatchObject({ email: 'alice@example.com', wallet_address: WALLET });
    expect(second.id).toBe(first.id);
  });

  it('keeps a known wallet when the provider stops returning it', async () => {
    await call('GET', '/v1/me', 'alice');
    tokens.alice = { ...tokens.alice!, walletAddress: null };
    expect((await call('GET', '/v1/me', 'alice')).json().wallet_address).toBe(WALLET);
    tokens.alice = { ...tokens.alice!, walletAddress: WALLET };
  });

  it('saves a chat exchange and returns it in order', async () => {
    const sent = await call('POST', '/v1/chat/messages', 'alice', { content: 'send airtime to Kc' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().reply.role).toBe('assistant');
    const { messages } = (await call('GET', '/v1/chat/messages', 'alice')).json();
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('send airtime to Kc');
  });

  it('never shows one user the messages of another', async () => {
    await call('POST', '/v1/chat/messages', 'alice', { content: 'private' });
    expect((await call('GET', '/v1/chat/messages', 'bob')).json().messages).toEqual([]);
  });

  it.each([[{}], [{ content: '   ' }], [{ content: 'x'.repeat(6001) }]])('refuses bad input %#', async (body) => {
    expect((await call('POST', '/v1/chat/messages', 'alice', body)).statusCode).toBe(400);
  });

  it('allows only the configured web origin', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/v1/me',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    expect((await preflight('http://allowed.test')).headers['access-control-allow-origin']).toBe('http://allowed.test');
    expect((await preflight('http://evil.test')).headers['access-control-allow-origin']).toBeUndefined();
  });
});
