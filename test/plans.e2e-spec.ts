import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { Chain } from '../src/chain/chain.service';
import { ContactRefused, ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { ProposedItem } from '../src/plans/plan.types';
import { presentPlan } from '../src/plans/plans.controller';
import { PlanRefused, PlansService } from '../src/plans/plans.service';
import { PaymentProvider } from '../src/providers/providers';
import { User } from '../src/database/schema';
import { UsersRepository } from '../src/users/users.repository';

const DATABASE_URL = process.env.DATABASE_URL!;

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (!['alice', 'bob'].includes(token)) throw new InvalidIdentityError('bad');
    return { subject: `did:privy:${token}`, email: null, walletAddress: null };
  }
}

describe('plans and contacts', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let plans: PlansService;
  let contacts: ContactsService;
  let alice: string;
  let bob: string;

  const post = (url: string, token: string) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });
  const bank = (naira: number, destinationId: string): ProposedItem => ({
    route: 'bank', destinationId, amountNaira: naira, amountUsdc: null, dataPlanId: null,
  });

  async function saved(userId: string, name: string, destination: Parameters<ContactsService['propose']>[3]) {
    const contact = await contacts.propose(userId, name, [], destination);
    await contacts.confirm(userId, contact.id);
    return contact.destinations[0]!;
  }
  const mother = (userId = alice) => saved(userId, 'Mother', { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });

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
    plans = app.get(PlansService, { strict: false });
    contacts = app.get(ContactsService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    const users = app.get(UsersRepository, { strict: false });
    alice = (await users.upsert({ subject: 'did:privy:alice', email: null, walletAddress: null })).id;
    bob = (await users.upsert({ subject: 'did:privy:bob', email: null, walletAddress: null })).id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('refuses a bank transfer under the partner minimum before showing a card, and allows one at it', async () => {
    const destination = await mother();
    const provider = app.get(PaymentProvider, { strict: false });
    const minimum = jest.spyOn(provider, 'minimumUsdcMinor').mockReturnValue(1_000_000);
    await expect(plans.propose(alice, [bank(1000, destination.id)])).rejects.toThrow('The smallest bank transfer is 1.00 USDC, about ₦1,500.');
    await expect(plans.propose(alice, [bank(1500, destination.id)])).resolves.toBeDefined();
    minimum.mockRestore();
  });

  it('takes a USDC amount to a bank account as exactly that much USDC, paid out in naira', async () => {
    const destination = await mother();
    const plan = await plans.propose(alice, [{ route: 'bank', destinationId: destination.id, amountNaira: null, amountUsdc: '1.5', dataPlanId: null }]);
    expect(plan.items[0]).toMatchObject({ route: 'bank', usdcMinor: 1_500_000, amountKobo: 225_000 });
  });

  describe('activity and receipts', () => {
    const get = (url: string, token = 'alice') => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    const insert = (userId: string, overrides: object = {}) => {
      const row = { status: 'completed', route: 'bank', amount: 137636, usdc: 1000000, ref: 'switch-1', when: new Date('2026-11-03T18:06:00Z').toISOString(), ...overrides };
      return pool.query(
        `INSERT INTO payments (user_id, route, amount_kobo, usdc_minor, recipient_name, destination, status, provider_reference, funding_tx_hash, created_at)
         VALUES ($1, $2, $3, $4, 'Halima', $5, $6, $7, '0xabc', $8) RETURNING id`,
        [userId, row.route, row.amount, row.usdc, JSON.stringify({ kind: 'bank', accountName: 'Ada Bello', bankName: 'OPay', accountNumber: '8031234568' }), row.status, row.ref, row.when],
      );
    };

    it('splits activity into pages, newest first', async () => {
      for (let day = 1; day <= 12; day += 1) await insert(alice, { when: new Date(Date.UTC(2026, 10, day)).toISOString() });
      const first = (await get('/v1/activity')).json();
      expect(first).toMatchObject({ page: 1, per_page: 6, total: 12 });
      expect(first.activity).toHaveLength(6);
      expect(first.activity[0].created_at).toContain('2026-11-12');
      const second = (await get('/v1/activity?page=2')).json();
      expect(second.activity).toHaveLength(6);
      expect(second.activity[5].created_at).toContain('2026-11-01');
      expect((await get('/v1/activity?page=0')).statusCode).toBe(400);
      expect((await get('/v1/activity?page=abc')).statusCode).toBe(400);
    });

    it('filters by direction, type, search and date, and names things plainly', async () => {
      await insert(alice, { when: '2026-11-01T10:00:00Z' });
      await insert(alice, { route: 'airtime', when: '2026-11-03T10:00:00Z' });
      await pool.query(`INSERT INTO deposits (user_id, tx_hash, log_index, from_address, usdc_minor, created_at) VALUES ($1, '0xdep', 0, '0xe1a9cDb2907134c35E8d055DD72605331f4E642d', 2000000, '2026-11-02T10:00:00Z')`, [alice]);
      const list = async (query: string) => (await get(`/v1/activity?${query}`)).json();

      const all = await list('');
      expect(all.total).toBe(3);
      expect(all.activity.map((e: { description: string }) => e.description)).toEqual(['Airtime for Halima', 'Received from 0xe1a9…642d', 'Sent to Halima']);
      expect(all.activity[2]).toMatchObject({ direction: 'out', type: 'bank', detail: 'Ada Bello, OPay ****4568' });
      expect(all.activity[1]).toMatchObject({ direction: 'in', type: 'deposit' });

      expect((await list('direction=in')).activity).toHaveLength(1);
      expect((await list('direction=out')).total).toBe(2);
      expect((await list('type=airtime')).activity[0].type).toBe('airtime');
      expect((await list('type=deposit')).total).toBe(1);
      expect((await list('type=deposit&direction=out')).total).toBe(0);
      expect((await list('search=hal')).total).toBe(2);
      expect((await list('search=%25')).total).toBe(0);
      expect((await list('search=received')).total).toBe(1);
      expect((await list('from=2026-11-02&to=2026-11-02')).activity[0].kind).toBe('deposit');
      expect((await get('/v1/activity?from=nope')).statusCode).toBe(400);
      expect((await get('/v1/activity?type=stocks')).statusCode).toBe(400);
    });

    it('names a naira deposit by the naira that was paid in', async () => {
      await pool.query(`INSERT INTO naira_deposits (id, user_id, amount_kobo, usdc_minor, rate, account_number, expires_at, status, completed_at) VALUES (gen_random_uuid(), $1, 200000, 1441161, '1387', '0', now(), 'completed', now())`, [alice]);
      await pool.query(`INSERT INTO deposits (user_id, tx_hash, log_index, from_address, usdc_minor) VALUES ($1, '0xdep', 0, '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF', 1441156)`, [alice]);
      expect((await get('/v1/activity')).json().activity[0]).toMatchObject({ description: 'Deposited ₦2,000', type_label: 'Naira deposit' });
    });

    it('downloads the filtered list as a spreadsheet, masked and safe to open', async () => {
      await insert(alice, { when: '2026-11-03T10:00:00Z' });
      await pool.query(`UPDATE payments SET recipient_name = '=HYPERLINK("x")' WHERE user_id = $1`, [alice]);
      await insert(alice, { route: 'airtime', when: '2026-11-03T11:00:00Z' });
      await pool.query(`UPDATE payments SET recipient_name = 'Tunde' WHERE route = 'airtime' AND user_id = $1`, [alice]);
      const file = await get('/v1/activity/export?type=bank');
      expect(file.headers['content-type']).toContain('text/csv');
      const lines = file.body.trim().split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Date,Description');
      expect(file.body).toContain('****4568');
      expect(file.body).not.toContain('8031234568');
      expect(file.body).not.toContain('Tunde');
      expect((await get('/v1/activity/export', 'bob')).body.trim().split('\r\n')).toHaveLength(1);
    });

    it('makes a receipt for a finished payment, with the account number masked', async () => {
      const { id } = (await insert(alice)).rows[0];
      const response = await get(`/v1/receipts/payment/${id}`);
      expect(response.json().receipt).toMatchObject({ title: 'Payment successful', kind: 'Bank transfer', recipient: 'Halima', recipient_detail: 'Ada Bello, OPay ****4568', amount: '₦1,376.36', tx_hash: '0xabc' });
      expect(response.body).not.toContain('8031234568');
      expect((await get('/v1/activity')).json().activity[0].has_receipt).toBe(true);
    });

    it('refuses a receipt for unfinished, simulated or someone else\'s payments', async () => {
      const unfinished = (await insert(alice, { status: 'paying' })).rows[0].id;
      const simulated = (await insert(alice, { ref: 'simulated-1' })).rows[0].id;
      const mine = (await insert(alice)).rows[0].id;
      expect((await get(`/v1/receipts/payment/${unfinished}`)).statusCode).toBe(404);
      expect((await get(`/v1/receipts/payment/${simulated}`)).statusCode).toBe(404);
      expect((await get(`/v1/receipts/payment/${mine}`, 'bob')).statusCode).toBe(404);
      expect((await get(`/v1/receipts/other/${mine}`)).statusCode).toBe(404);
      const list = (await get('/v1/activity')).json().activity;
      expect(list.filter((entry: { has_receipt: boolean }) => entry.has_receipt)).toHaveLength(1);
    });
  });

  describe('contacts', () => {
    it('stores the name the bank gives, and the network of a phone', async () => {
      const account = await contacts.propose(alice, 'Mother', ['mum'], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
      expect(account.destinations[0]!.accountName).toBe('SIMULATED HOLDER 4821');
      const phone = await contacts.propose(alice, 'Kc', [], { kind: 'phone', phone: '+234 803 123 4567' });
      expect(phone.destinations[0]).toMatchObject({ phone: '08031234567', network: 'MTN' });
    });

    it.each([
      [{ kind: 'bank', bankName: 'Access', accountNumber: '12345' }],
      [{ kind: 'bank', bankName: 'Access', accountNumber: '0123459999' }],
      [{ kind: 'phone', phone: '12345' }],
      [{ kind: 'wallet', walletAddress: '0xnot' }],
    ] as const)('refuses a bad destination %#', async (destination) => {
      await expect(contacts.propose(alice, 'X', [], destination)).rejects.toBeInstanceOf(ContactRefused);
    });
  });

  describe('proposing', () => {
    it('names the network on a USDC payment, and shows the whole address', async () => {
      const address = '0xe1a9cDb2907134c35E8d055DD72605331f4E642d';
      const wallet = await saved(alice, 'Ada', { kind: 'wallet', walletAddress: address });
      const plan = await plans.propose(alice, [{ route: 'usdc', destinationId: wallet.id, amountNaira: null, amountUsdc: '1', dataPlanId: null }]);
      const shown = presentPlan(plan).items[0]!;
      expect(shown.recipient_detail).toBe(address);
      expect(shown.network).toMatch(/^Base/);
    });

    it('refuses USDC to the token contract and to the sender, whose addresses are never right', async () => {
      const token = await saved(alice, 'Token', { kind: 'wallet', walletAddress: app.get(Chain, { strict: false }).usdcAddress() });
      await expect(
        plans.propose(alice, [{ route: 'usdc', destinationId: token.id, amountNaira: null, amountUsdc: '1', dataPlanId: null }]),
      ).rejects.toThrow('USDC token contract');
      const own = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';
      const sender = (await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:privy:own-wallet', email: null, walletAddress: own })).id;
      const self = await saved(sender, 'Me', { kind: 'wallet', walletAddress: own });
      await expect(
        plans.propose(sender, [{ route: 'usdc', destinationId: self.id, amountNaira: null, amountUsdc: '1', dataPlanId: null }]),
      ).rejects.toThrow('your own wallet');
    });

    it('says what is wrong with a mistyped wallet address', async () => {
      const mistyped = '0xe1a9cdb2907134c35E8d055DD72605331f4E642d';
      await expect(contacts.propose(alice, 'Typo', [], { kind: 'wallet', walletAddress: mistyped })).rejects.toThrow('mistake');
      await expect(contacts.propose(alice, 'Solana', [], { kind: 'wallet', walletAddress: 'So11111111111111111111111111111111111111112' })).rejects.toThrow('Base wallet address');
    });

    it('prices a mixed plan, taking the data price from the catalogue', async () => {
      const account = await mother();
      const phone = await saved(alice, 'Kc', { kind: 'phone', phone: '08031234567' });
      const wallet = await saved(alice, 'Halima', { kind: 'wallet', walletAddress: '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d' });
      const plan = await plans.propose(alice, [
        { route: 'airtime', destinationId: phone.id, amountNaira: 50, amountUsdc: null, dataPlanId: null },
        { route: 'data', destinationId: phone.id, amountNaira: 1, amountUsdc: null, dataPlanId: 'mtn-1gb' },
        bank(5000, account.id),
        { route: 'usdc', destinationId: wallet.id, amountNaira: null, amountUsdc: '20', dataPlanId: null },
      ]);
      expect(plan.status).toBe('proposed');
      expect(plan.items.map((item) => item.amountKobo)).toEqual([5000, 100000, 500000, 3000000]);
      expect(plan.items[3]!.usdcMinor).toBe(20_000_000);
    });

    it('saves a new phone only when its plan is approved, with one approval', async () => {
      const contact = await contacts.propose(alice, 'Tayo', [], { kind: 'phone', phone: '08031234567' });
      const id = contact.destinations[0]!.id;
      const item = { route: 'airtime' as const, destinationId: id, amountNaira: 100, amountUsdc: null, dataPlanId: null, newRecipient: true };
      const plan = await plans.propose(alice, [item]);
      expect((await contacts.listConfirmed(alice)).some((c) => c.id === contact.id)).toBe(false);
      expect((await post(`/v1/plans/${plan.id}/approve`, 'alice')).statusCode).toBeLessThan(300);
      expect((await contacts.listConfirmed(alice)).some((c) => c.id === contact.id)).toBe(true);
    });

    it('pays and saves a new wallet with one approval, showing its whole address', async () => {
      const address = '0x8fA8187B90c971049a993b268F400D2ff3d6aDCB';
      const contact = await contacts.propose(alice, address, [], { kind: 'wallet', walletAddress: address });
      const plan = await plans.propose(alice, [{ route: 'usdc', destinationId: contact.destinations[0]!.id, amountNaira: null, amountUsdc: '0.1', dataPlanId: null, newRecipient: true }]);
      expect(plan.items[0]!.recipientDetail).toBe(address);
      expect((await post(`/v1/plans/${plan.id}/approve`, 'alice')).statusCode).toBeLessThan(300);
      expect((await contacts.listConfirmed(alice)).some((c) => c.id === contact.id)).toBe(true);
    });

    it('pays and saves a new bank account with one approval, showing the name the bank gives', async () => {
      const contact = await contacts.propose(alice, '', [], { kind: 'bank', bankName: 'OPay', accountNumber: '8031234570' });
      expect(contact.name).toBe(contact.destinations[0]!.accountName);
      const plan = await plans.propose(alice, [{ route: 'bank', destinationId: contact.destinations[0]!.id, amountNaira: 2000, amountUsdc: null, dataPlanId: null, newRecipient: true }]);
      expect(plan.items[0]!.recipientDetail).toContain(contact.destinations[0]!.accountName!);
      expect((await post(`/v1/plans/${plan.id}/approve`, 'alice')).statusCode).toBeLessThan(300);
      expect((await contacts.listConfirmed(alice)).some((c) => c.id === contact.id)).toBe(true);
    });

    it('does not save a new phone when the plan is rejected', async () => {
      const contact = await contacts.propose(alice, 'Tayo', [], { kind: 'phone', phone: '08031234567' });
      const plan = await plans.propose(alice, [{ route: 'airtime', destinationId: contact.destinations[0]!.id, amountNaira: 100, amountUsdc: null, dataPlanId: null, newRecipient: true }]);
      await plans.reject(alice, plan.id);
      expect((await contacts.listConfirmed(alice)).some((c) => c.id === contact.id)).toBe(false);
    });

    it('allows the new-phone shortcut only for airtime to a phone of your own', async () => {
      const account = await contacts.propose(alice, 'New', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
      const phone = await contacts.propose(bob, 'Theirs', [], { kind: 'phone', phone: '08031234567' });
      await expect(plans.propose(alice, [{ route: 'airtime', destinationId: account.destinations[0]!.id, amountNaira: 100, amountUsdc: null, dataPlanId: null, newRecipient: true }])).rejects.toBeInstanceOf(PlanRefused);
      await expect(plans.propose(alice, [{ route: 'airtime', destinationId: phone.destinations[0]!.id, amountNaira: 100, amountUsdc: null, dataPlanId: null, newRecipient: true }])).rejects.toBeInstanceOf(PlanRefused);
      await expect(plans.propose(alice, [{ route: 'airtime', destinationId: phone.destinations[0]!.id, amountNaira: 100, amountUsdc: null, dataPlanId: null }])).rejects.toBeInstanceOf(PlanRefused);
    });

    it('refuses an unconfirmed contact', async () => {
      const contact = await contacts.propose(alice, 'New', [], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
      await expect(plans.propose(alice, [bank(100, contact.destinations[0]!.id)])).rejects.toBeInstanceOf(PlanRefused);
    });

    it("refuses another user's contact", async () => {
      const theirs = await mother(bob);
      await expect(plans.propose(alice, [bank(100, theirs.id)])).rejects.toBeInstanceOf(PlanRefused);
    });

    it.each([0, -5, 1.5, null])('refuses the naira amount %s', async (amount) => {
      const account = await mother();
      await expect(plans.propose(alice, [{ ...bank(1, account.id), amountNaira: amount }])).rejects.toBeInstanceOf(PlanRefused);
    });

    it('refuses a route the recipient cannot receive', async () => {
      const phone = await saved(alice, 'Kc', { kind: 'phone', phone: '08031234567' });
      await expect(plans.propose(alice, [bank(100, phone.id)])).rejects.toBeInstanceOf(PlanRefused);
    });

    it('refuses a data plan from another network', async () => {
      const phone = await saved(alice, 'Kc', { kind: 'phone', phone: '08051234567' });
      await expect(
        plans.propose(alice, [{ route: 'data', destinationId: phone.id, amountNaira: null, amountUsdc: null, dataPlanId: 'mtn-1gb' }]),
      ).rejects.toBeInstanceOf(PlanRefused);
    });

    it('moves no money', async () => {
      await plans.propose(alice, [bank(5000, (await mother()).id)]);
      expect((await pool.query('SELECT count(*) FROM payments')).rows[0].count).toBe('0');
    });
  });

  describe('approving', () => {
    it('pays each item once and records the result', async () => {
      const plan = await plans.propose(alice, [bank(5000, (await mother()).id)]);
      const approved = await plans.approve({ id: alice, walletAddress: null } as User, plan.id);
      expect(approved.status).toBe('approved');
      expect(approved.items[0]!.payment).toMatchObject({ status: 'completed', amountKobo: 500000 });
    });

    it('cannot pay twice, even when approved at the same moment', async () => {
      const plan = await plans.propose(alice, [bank(5000, (await mother()).id)]);
      const results = await Promise.allSettled([plans.approve({ id: alice, walletAddress: null } as User, plan.id), plans.approve({ id: alice, walletAddress: null } as User, plan.id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await pool.query('SELECT count(*) FROM payments')).rows[0].count).toBe('1');
    });

    it("cannot approve another user's plan", async () => {
      const plan = await plans.propose(alice, [bank(5000, (await mother()).id)]);
      expect((await post(`/v1/plans/${plan.id}/approve`, 'bob')).statusCode).toBe(404);
      expect((await pool.query('SELECT count(*) FROM payments')).rows[0].count).toBe('0');
    });

    it('cannot approve a rejected plan', async () => {
      const plan = await plans.propose(alice, [bank(5000, (await mother()).id)]);
      expect((await post(`/v1/plans/${plan.id}/reject`, 'alice')).json().status).toBe('rejected');
      expect((await post(`/v1/plans/${plan.id}/approve`, 'alice')).statusCode).toBe(409);
    });

    it('refuses an expired quote and moves nothing', async () => {
      const plan = await plans.propose(alice, [bank(5000, (await mother()).id)]);
      await pool.query("UPDATE plans SET quote_expires_at = now() - interval '1 minute' WHERE id = $1", [plan.id]);
      expect((await post(`/v1/plans/${plan.id}/approve`, 'alice')).statusCode).toBe(422);
      expect((await plans.get(alice, plan.id)).status).toBe('expired');
      expect((await pool.query('SELECT count(*) FROM payments')).rows[0].count).toBe('0');
    });

    it('records a failed payment without stopping the others', async () => {
      const bad = await saved(alice, 'Bad', { kind: 'bank', bankName: 'Access', accountNumber: '0123450000' });
      const plan = await plans.propose(alice, [bank(100, bad.id), bank(200, (await mother()).id)]);
      const approved = await plans.approve({ id: alice, walletAddress: null } as User, plan.id);
      expect(approved.items.map((item) => item.payment?.status)).toEqual(['failed', 'completed']);
      expect(approved.items[0]!.payment?.failureReason).toContain('Simulated failure');
    });
  });

  describe('the N500,000 daily limit', () => {
    it('allows exactly N500,000', async () => {
      const plan = await plans.propose(alice, [bank(500_000, (await mother()).id)]);
      await expect(plans.approve({ id: alice, walletAddress: null } as User, plan.id)).resolves.toMatchObject({ status: 'approved' });
    });

    it('refuses N500,001 at proposal', async () => {
      await expect(plans.propose(alice, [bank(500_001, (await mother()).id)])).rejects.toThrow('daily limit');
    });

    it('adds up every route, counting USDC at its naira value', async () => {
      const account = await mother();
      const wallet = await saved(alice, 'Halima', { kind: 'wallet', walletAddress: '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d' });
      await plans.approve({ id: alice, walletAddress: null } as User, (await plans.propose(alice, [bank(400_000, account.id)])).id);
      const usdc = (amount: string): ProposedItem => ({ route: 'usdc', destinationId: wallet.id, amountNaira: null, amountUsdc: amount, dataPlanId: null });
      await expect(plans.propose(alice, [usdc('67')])).rejects.toThrow('daily limit');
      await expect(plans.propose(alice, [usdc('66')])).resolves.toBeDefined();
    });

    it('checks again at approval, when two plans each fit alone', async () => {
      const account = await mother();
      const first = await plans.propose(alice, [bank(300_000, account.id)]);
      const second = await plans.propose(alice, [bank(300_000, account.id)]);
      const results = await Promise.allSettled([plans.approve({ id: alice, walletAddress: null } as User, first.id), plans.approve({ id: alice, walletAddress: null } as User, second.id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await pool.query('SELECT sum(amount_kobo)::text AS total FROM payments')).rows[0].total).toBe('30000000');
    });

    it('does not count failed payments', async () => {
      const bad = await saved(alice, 'Bad', { kind: 'bank', bankName: 'Access', accountNumber: '0123450000' });
      await plans.approve({ id: alice, walletAddress: null } as User, (await plans.propose(alice, [bank(400_000, bad.id)])).id);
      await expect(plans.propose(alice, [bank(400_000, (await mother()).id)])).resolves.toBeDefined();
    });

    it('is separate for each user', async () => {
      await plans.approve({ id: alice, walletAddress: null } as User, (await plans.propose(alice, [bank(500_000, (await mother()).id)])).id);
      await expect(plans.propose(bob, [bank(500_000, (await mother(bob)).id)])).resolves.toBeDefined();
    });
  });
});
