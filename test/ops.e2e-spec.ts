import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { User } from '../src/database/schema';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { PinService } from '../src/pin/pin.service';
import { PlansService } from '../src/plans/plans.service';
import { SchedulerService } from '../src/schedules/scheduler.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { UsersRepository } from '../src/users/users.repository';

const ADMIN = 'admin-token-for-tests-only-0001';
const SPONSOR = 'sponsor-token-for-tests-only-001';

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (token !== 'alice') throw new InvalidIdentityError('bad');
    return { subject: 'did:privy:alice', email: null, walletAddress: '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d' };
  }
}

describe('hardening', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let alice: User;
  let plans: PlansService;
  let destinationId: string;

  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: object) =>
    app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload ? { payload } : {}) });
  const bank = (naira: number) => [{ route: 'bank' as const, destinationId, amountNaira: naira, amountUsdc: null, dataPlanId: null }];

  beforeAll(async () => {
    await applyMigrations(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    plans = app.get(PlansService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, op_switches, audit_log CASCADE');
    alice = await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:privy:alice', email: null, walletAddress: '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d' });
    const contacts = app.get(ContactsService, { strict: false });
    const saved = await contacts.propose(alice.id, 'Mother', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
    await contacts.confirm(alice.id, saved.id);
    destinationId = saved.destinations[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  describe('admin API', () => {
    it('refuses without the right token', async () => {
      expect((await call('GET', '/v1/admin/overview')).statusCode).toBe(401);
      expect((await call('GET', '/v1/admin/overview', 'alice')).statusCode).toBe(401);
      expect((await call('GET', '/v1/admin/overview', `${ADMIN}x`)).statusCode).toBe(401);
      expect((await call('GET', '/v1/admin/overview', ADMIN)).statusCode).toBe(200);
    });

    it('pauses everything, a route, and the pause is audited and lifted', async () => {
      await call('POST', '/v1/admin/switches', ADMIN, { name: 'payments', paused: true });
      await expect(plans.propose(alice.id, bank(100))).rejects.toThrow(/paused/);
      await call('POST', '/v1/admin/switches', ADMIN, { name: 'payments', paused: false });

      const plan = await plans.propose(alice.id, bank(100));
      await call('POST', '/v1/admin/switches', ADMIN, { name: 'bank', paused: true });
      await expect(plans.approve(alice, plan.id)).rejects.toThrow(/Bank payments are paused/);
      await call('POST', '/v1/admin/switches', ADMIN, { name: 'bank', paused: false });
      await expect(plans.approve(alice, plan.id)).resolves.toBeDefined();

      const { entries } = (await call('GET', '/v1/admin/audit', ADMIN)).json();
      expect(entries.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(['switch.paused', 'switch.resumed', 'plan.approved', 'plan.proposed']));
      const approved = entries.find((entry: { action: string }) => entry.action === 'plan.approved');
      const { rows } = await pool.query('select email from users where id = $1', [alice.id]);
      expect(approved.actor_email).toBe(rows[0].email);
    });

    it('holds a due schedule under a route pause', async () => {
      const schedules = app.get(SchedulesService, { strict: false });
      const scheduler = app.get(SchedulerService, { strict: false });
      const group = await schedules.propose(alice.id, [{ ...bank(100)[0]!, timing: { kind: 'once', delayMinutes: 1, date: null, time: null } }]);
      await schedules.approve(alice, group.groupId);
      await call('POST', '/v1/admin/switches', ADMIN, { name: 'bank', paused: true });
      await scheduler.tick(new Date(Date.now() + 120000));
      expect((await pool.query('select * from payments')).rows).toHaveLength(0);
    });

    it('resolves only a payment marked as needing support, and tells the user', async () => {
      const plan = await plans.approve(alice, (await plans.propose(alice.id, bank(100))).id);
      const id = plan.items[0]!.payment!.id;
      expect((await call('POST', `/v1/admin/payments/${id}/resolve`, ADMIN, { status: 'completed', note: 'checked' })).statusCode).toBe(400);
      await pool.query("update payments set status = 'needs_support' where id = $1", [id]);
      expect((await call('POST', `/v1/admin/payments/${id}/resolve`, ADMIN, { status: 'returned' })).statusCode).toBe(400);
      expect((await call('POST', `/v1/admin/payments/${id}/resolve`, ADMIN, { status: 'returned', note: 'checked the chain' })).statusCode).toBe(200);
      const texts = (await pool.query('select content from chat_messages where user_id = $1', [alice.id])).rows.map((row) => row.content);
      expect(texts.join(' ')).toMatch(/USDC is back in your wallet/);
    });

    it('lists users, every payment, merchants and daily stats, for the admin only', async () => {
      const plan = await plans.approve(alice, (await plans.propose(alice.id, bank(100))).id);
      await pool.query("update payments set status = 'completed' where id = $1", [plan.items[0]!.payment!.id]);
      for (const path of ['users', 'payments', 'merchants', 'stats']) expect((await call('GET', `/v1/admin/${path}`, 'alice')).statusCode).toBe(401);

      const { users } = (await call('GET', '/v1/admin/users', ADMIN)).json();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ id: alice.id, payments: 1, sent: '₦100' });
      expect((await call('GET', '/v1/admin/users?q=nobody%25', ADMIN)).json().users).toHaveLength(0);

      const { payments } = (await call('GET', '/v1/admin/payments?status=completed', ADMIN)).json();
      expect(payments.filter((row: { kind: string }) => row.kind === 'app')).toHaveLength(1);
      expect(payments[0]).toMatchObject({ kind: 'app', channel: 'Bank', to: 'Mother', amount: '₦100' });
      expect((await call('GET', '/v1/admin/payments?status=failed', ADMIN)).json().payments).toHaveLength(0);

      const merchants = (await call('GET', '/v1/admin/merchants', ADMIN)).json();
      expect(merchants).toMatchObject({ merchant_keys: [], payment_links: [] });

      const stats = (await call('GET', '/v1/admin/stats', ADMIN)).json();
      expect(stats.days).toHaveLength(14);
      // Agent payments from other suites can remain in this table, so those counts are at least ours.
      expect(stats.totals).toMatchObject({ users: 1, users_7d: 1 });
      expect(stats.totals.payments_paid).toBeGreaterThanOrEqual(1);
      expect(stats.days.at(-1).signups).toBe(1);
      expect(stats.days.at(-1).payments).toBeGreaterThanOrEqual(1);
    });

    it('lists stuck payments', async () => {
      const plan = await plans.approve(alice, (await plans.propose(alice.id, bank(100))).id);
      await pool.query("update payments set status = 'needs_support' where id = $1", [plan.items[0]!.payment!.id]);
      const overview = (await call('GET', '/v1/admin/overview', ADMIN)).json();
      expect(overview.open_payments).toHaveLength(1);
      expect(overview.open_payments[0].recipient).toBe('Mother');
    });
  });

  it('stops all users at the company cap', async () => {
    await pool.query("insert into payments (user_id, route, amount_kobo, usdc_minor, status) values ($1, 'bank', 49000000000, 1, 'completed')", [alice.id]);
    await pool.query("insert into users (provider_subject) values ('other')");
    const other = (await pool.query("select id from users where provider_subject = 'other'")).rows[0].id;
    const contacts = app.get(ContactsService, { strict: false });
    const saved = await contacts.propose(other, 'X', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454822' });
    await contacts.confirm(other, saved.id);
    await expect(plans.propose(other, [{ route: 'bank', destinationId: saved.destinations[0]!.id, amountNaira: 200000, amountUsdc: null, dataPlanId: null }])).rejects.toThrow(/busy/);
  });

  describe('PIN', () => {
    const planId = async () => (await plans.propose(alice.id, bank(100))).id;

    it('refuses weak PINs and never stores the PIN', async () => {
      expect((await call('POST', '/v1/pin', 'alice', { pin: '1234' })).statusCode).toBe(422);
      expect((await call('POST', '/v1/pin', 'alice', { pin: '12a4' })).statusCode).toBe(422);
      expect((await call('POST', '/v1/pin', 'alice', { pin: '4829' })).statusCode).toBe(200);
      const { rows } = await pool.query('select pin_hash from users where id = $1', [alice.id]);
      expect(rows[0].pin_hash).not.toContain('4829');
    });

    it('needs the PIN to approve once set', async () => {
      await call('POST', '/v1/pin', 'alice', { pin: '4829' });
      const id = await planId();
      expect((await call('POST', `/v1/plans/${id}/approve`, 'alice', {})).statusCode).toBe(403);
      expect((await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '0001' })).statusCode).toBe(403);
      expect((await pool.query('select * from payments')).rows).toHaveLength(0);
      expect((await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '4829' })).statusCode).toBe(200);
    });

    it('locks after five wrong tries, even with the right PIN, and support can reset it', async () => {
      await call('POST', '/v1/pin', 'alice', { pin: '4829' });
      const id = await planId();
      for (let i = 0; i < 5; i += 1) await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '0001' });
      const locked = await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '4829' });
      expect(locked.statusCode).toBe(403);
      expect(locked.json().message).toMatch(/Too many/);
      await call('POST', `/v1/admin/users/${alice.id}/reset-pin`, ADMIN);
      await call('POST', '/v1/pin', 'alice', { pin: '5930' });
      expect((await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '5930' })).statusCode).toBe(200);
    });

    it('guesses sent together cannot get past the five-try limit', async () => {
      await call('POST', '/v1/pin', 'alice', { pin: '4829' });
      const id = await planId();
      await Promise.all(Array.from({ length: 12 }, () => call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '0001' })));
      const locked = await call('POST', `/v1/plans/${id}/approve`, 'alice', { pin: '4829' });
      expect(locked.json().message).toMatch(/Too many/);
      const { rows } = await pool.query("select count(*)::int as tries from audit_log where action in ('pin.wrong', 'pin.locked')");
      expect(rows[0].tries).toBeLessThanOrEqual(5);
    });

    it('needs the current PIN to change it', async () => {
      await call('POST', '/v1/pin', 'alice', { pin: '4829' });
      expect((await call('POST', '/v1/pin', 'alice', { pin: '5930' })).statusCode).toBe(403);
      expect((await call('POST', '/v1/pin', 'alice', { pin: '5930', current_pin: '4829' })).statusCode).toBe(200);
    });

    it('asks for one when required', async () => {
      const pins = app.get(PinService, { strict: false });
      const required = jest.spyOn(pins, 'required', 'get').mockReturnValue(true);
      const id = await planId();
      const response = await call('POST', `/v1/plans/${id}/approve`, 'alice', {});
      expect(response.statusCode).toBe(403);
      expect(response.json().message).toMatch(/set a PIN/);
      required.mockRestore();
    });
  });

  it('never replaces a saved wallet', async () => {
    const users = app.get(UsersRepository, { strict: false });
    const after = await users.upsert({ subject: 'did:privy:alice', email: null, walletAddress: '0x000000000000000000000000000000000000dEaD' });
    expect(after.walletAddress).toBe(alice.walletAddress);
    const kept = await users.upsert({ subject: 'did:privy:alice', email: null, walletAddress: null });
    expect(kept.walletAddress).toBe(alice.walletAddress);
  });

  it('limits how fast one account can chat', async () => {
    await pool.query("insert into chat_messages (user_id, role, content) select $1, 'user', 'x' from generate_series(1, 20)", [alice.id]);
    expect((await call('POST', '/v1/chat/messages', 'alice', { content: 'one more' })).statusCode).toBe(429);
  });

  it('tells the gas proxy only about our own wallets, and only with its token', async () => {
    const ask = (token: string, address: string) => call('POST', '/v1/internal/sponsorship/wallet', undefined, { token, address });
    expect((await ask('wrong', alice.walletAddress!)).statusCode).toBe(401);
    expect((await ask(SPONSOR, alice.walletAddress!.toLowerCase())).json().known).toBe(true);
    expect((await ask(SPONSOR, '0x000000000000000000000000000000000000dEaD')).json().known).toBe(false);
  });
});
