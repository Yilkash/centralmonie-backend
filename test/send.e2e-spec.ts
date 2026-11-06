import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { UsersRepository } from '../src/users/users.repository';

const DATABASE_URL = process.env.DATABASE_URL!;

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (!['alice', 'bob'].includes(token)) throw new InvalidIdentityError('bad');
    return { subject: `did:privy:${token}`, email: null, walletAddress: null };
  }
}

describe('the Send page', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let contacts: ContactsService;
  let alice: string;
  const call = (method: 'GET' | 'POST', url: string, token: string, body?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  const unconfirmed = async () => Number((await pool.query(`select count(*) from contacts where status = 'proposed'`)).rows[0].count);

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    contacts = app.get(ContactsService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    const users = app.get(UsersRepository, { strict: false });
    alice = (await users.upsert({ subject: 'did:privy:alice', email: null, walletAddress: null })).id;
    await users.upsert({ subject: 'did:privy:bob', email: null, walletAddress: null });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('lists saved recipients by kind, the sixteen networks and the phone networks', async () => {
    const mother = await contacts.propose(alice, 'Mother', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
    await contacts.confirm(alice, mother.id);
    const ada = await contacts.propose(alice, 'Ada', [], { kind: 'wallet', walletAddress: 'GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB' });
    await contacts.confirm(alice, ada.id);
    const options = (await call('GET', '/v1/send/options', 'alice')).json();
    expect(options.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Mother', kind: 'bank' }),
        expect.objectContaining({ name: 'Ada', kind: 'wallet', network: 'Stellar' }),
      ]),
    );
    expect(options.networks).toHaveLength(16);
    expect(options.networks.find((item: { id: string }) => item.id === 'tron')).toEqual({ id: 'tron', name: 'Tron', token: 'USDT' });
    expect(options.phone_networks).toEqual(['MTN', 'Airtel', 'Glo', '9mobile']);
    expect((await call('GET', '/v1/send/options', 'bob')).json().recipients).toEqual([]);
  });

  it('prepares a bank transfer to a saved recipient, for the same approval card as the chat', async () => {
    const mother = await contacts.propose(alice, 'Mother', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
    await contacts.confirm(alice, mother.id);
    const response = await call('POST', '/v1/send', 'alice', { route: 'bank', destination_id: mother.destinations[0]!.id, amount_naira: 5000 });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan).toMatchObject({ status: 'proposed', items: [{ route: 'bank', recipient_name: 'Mother', amount_naira: '₦5,000' }] });
  });

  it('prepares a send to a new Stellar wallet, saving it only when approved', async () => {
    const response = await call('POST', '/v1/send', 'alice', { route: 'usdc', amount_usdc: '5', new_recipient: { name: 'Ada', wallet_address: 'GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan.items[0]).toMatchObject({ route: 'usdc', recipient_name: 'Ada', network: 'Stellar' });
    expect(await unconfirmed()).toBe(1);
    expect((await call('GET', '/v1/send/options', 'alice')).json().recipients).toEqual([]);
  });

  it('says what is wrong, and leaves no half-saved recipient behind', async () => {
    const typo = await call('POST', '/v1/send', 'alice', { route: 'usdc', amount_usdc: '5', new_recipient: { wallet_address: 'GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6Q5', wallet_chain: 'Stellar' } });
    expect(typo.statusCode).toBe(422);
    expect(typo.json().message).toContain('not a valid Stellar address');
    const tooMuch = await call('POST', '/v1/send', 'alice', { route: 'bank', amount_naira: 9_000_000, new_recipient: { bank_name: 'Access', account_number: '0123454821' } });
    expect(tooMuch.statusCode).toBe(422);
    expect(await unconfirmed()).toBe(0);
    const nobody = await call('POST', '/v1/send', 'alice', { route: 'bank', amount_naira: 5000 });
    expect(nobody.json().message).toBe('That payment needs a saved recipient first.');
    expect((await call('POST', '/v1/send', 'alice', { route: 'bank' })).statusCode).toBe(422);
  });

  it('lists data plans for a phone network, and refuses an unknown one', async () => {
    const mtn = (await call('GET', '/v1/send/data-plans?network=MTN', 'alice')).json();
    expect(mtn.plans.length).toBeGreaterThan(0);
    expect(mtn.plans[0]).toEqual({ id: expect.any(String), label: expect.any(String), price: expect.stringMatching(/^₦/) });
    expect((await call('GET', '/v1/send/data-plans?network=Etisalat', 'alice')).statusCode).toBe(422);
  });

  it('cannot be used without signing in', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/send/options' })).statusCode).toBe(401);
  });
});
