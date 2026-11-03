import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { ContactRefused, ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { ProposedItem } from '../src/plans/plan.types';
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
