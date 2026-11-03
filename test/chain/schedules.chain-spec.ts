import { ChildProcess } from 'node:child_process';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { configureApp, createAdapter } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { Chain } from '../../src/chain/chain.service';
import { ContactsService } from '../../src/contacts/contacts.service';
import { applyMigrations } from '../../src/database/migrate';
import { User } from '../../src/database/schema';
import { IdentityProvider } from '../../src/identity/identity-provider';
import { SchedulerService } from '../../src/schedules/scheduler.service';
import { ProposedSchedule, SchedulesService } from '../../src/schedules/schedules.service';
import { Timing } from '../../src/schedules/timing';
import { UsersRepository } from '../../src/users/users.repository';
import { address, dealUsdc, KEYS, smartWallet, startFork, syncClock, test as chainTest, usdcBalance, walletSend } from './fork';

const COLLECTION = address(KEYS.collection);
const RECIPIENT = '0x000000000000000000000000000000000000bEEF' as Address;
const DAY = 24 * 3600 * 1000;

class FakeIdentity extends IdentityProvider {
  async verify(): Promise<never> {
    throw new Error('not used');
  }
}

const inMinutes = (delayMinutes: number): Timing => ({ kind: 'once', delayMinutes, date: null, time: null });
const monthly: Timing = { kind: 'recurring', frequency: 'monthly', interval: 1, weekday: null, dayOfMonth: null, lastDayOfMonth: false, time: null, occurrences: null, startDate: null };

// The real Spend Permission Manager and a real Coinbase Smart Wallet: the user signs once, then the server pays with no signature.
describe('scheduled payments on a fork of Base Sepolia', () => {
  let anvil: ChildProcess;
  let app: NestFastifyApplication;
  let pool: Pool;
  let schedules: SchedulesService;
  let scheduler: SchedulerService;
  let contacts: ContactsService;
  let chain: Chain;
  let wallet: Address;
  let user: User;
  let walletDestination: string;
  let bankDestination: string;

  const usdcItem = (amountUsdc: string, timing: Timing): ProposedSchedule => ({ route: 'usdc', destinationId: walletDestination, amountNaira: null, amountUsdc, dataPlanId: null, timing });
  const bankItem = (amountNaira: number, timing: Timing): ProposedSchedule => ({ route: 'bank', destinationId: bankDestination, amountNaira, amountUsdc: null, dataPlanId: null, timing });
  const texts = async () => (await pool.query('select content from chat_messages where user_id = $1 order by created_at', [user.id])).rows.map((row) => row.content as string);
  const paymentRows = async () => (await pool.query('select status, funding_tx_hash from payments where user_id = $1 order by created_at', [user.id])).rows;

  async function saved(name: string, destination: Parameters<ContactsService['propose']>[3]) {
    const contact = await contacts.propose(user.id, name, [], destination);
    await contacts.confirm(user.id, contact.id);
    return contact.destinations[0]!.id;
  }

  /** Approves and signs. After this the wallet's key is never used again in the test. */
  async function live(items: ProposedSchedule[]) {
    const proposed = await schedules.propose(user.id, items);
    const approved = await schedules.approve(user, proposed.groupId);
    const hash = await walletSend(KEYS.user, wallet, approved.calls);
    await schedules.activate(user.id, proposed.groupId, hash);
    return approved;
  }

  beforeAll(async () => {
    anvil = await startFork();
    await applyMigrations(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    schedules = app.get(SchedulesService, { strict: false });
    scheduler = app.get(SchedulerService, { strict: false });
    contacts = app.get(ContactsService, { strict: false });
    chain = app.get(Chain, { strict: false });
    for (const key of Object.values(KEYS)) await chainTest.setBalance({ address: address(key), value: 10n ** 19n });
    wallet = await smartWallet(KEYS.user);
    await syncClock();
  }, 180000);

  beforeEach(async () => {
    await pool.query('TRUNCATE users, funding_transactions, chain_cursors CASCADE');
    user = await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:fork:user', email: null, walletAddress: wallet });
    await dealUsdc(wallet, 50_000_000n);
    await dealUsdc(COLLECTION, 0n);
    await dealUsdc(RECIPIENT, 0n);
    walletDestination = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    bankDestination = await saved('Mother', { kind: 'bank', bankName: 'GTBank', accountNumber: '0123456789' });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    anvil?.kill();
  });

  it('pays later with no second signature, in one transaction, and leaves nothing on the server account', async () => {
    const group = await live([usdcItem('2', inMinutes(30))]);
    expect(await usdcBalance(RECIPIENT)).toBe(0n);

    await scheduler.tick(new Date(Date.now() + 31 * 60000));

    expect(await usdcBalance(RECIPIENT)).toBe(2_000_000n);
    expect(await usdcBalance(wallet)).toBe(48_000_000n);
    expect(await usdcBalance((await chain.spender())!)).toBe(0n);
    expect((await paymentRows())[0]!.status).toBe('completed');
    expect((await schedules.get(user.id, group.items[0]!.id))!.status).toBe('completed');
  });

  it('collects for a naira payment and delivers', async () => {
    await live([bankItem(3000, inMinutes(5))]);
    await scheduler.tick(new Date(Date.now() + 6 * 60000));
    expect(await usdcBalance(COLLECTION)).toBe(2_000_000n);
    expect((await paymentRows())[0]!.status).toBe('completed');
  });

  it('approves several with one signature', async () => {
    const group = await live([usdcItem('1', inMinutes(5)), bankItem(1500, inMinutes(5)), usdcItem('0.5', inMinutes(10))]);
    expect(group.items).toHaveLength(3);
    await scheduler.tick(new Date(Date.now() + 15 * 60000));
    expect(await usdcBalance(RECIPIENT)).toBe(1_500_000n);
    expect(await usdcBalance(COLLECTION)).toBe(1_000_000n);
  });

  it('does not activate on a claim alone: the contract must hold the permission', async () => {
    const proposed = await schedules.propose(user.id, [usdcItem('1', inMinutes(5))]);
    await schedules.approve(user, proposed.groupId);
    const unrelated = await walletSend(KEYS.user, wallet, []);
    await expect(schedules.activate(user.id, proposed.groupId, unrelated)).rejects.toThrow(/not on the chain/);
    expect((await schedules.group(user.id, proposed.groupId)).status).toBe('awaiting_signature');
    await scheduler.tick(new Date(Date.now() + 60 * 60000));
    expect(await paymentRows()).toHaveLength(0);
  });

  it('does not send, and retries, when the wallet is short', async () => {
    const group = await live([usdcItem('10', inMinutes(5))]);
    await dealUsdc(wallet, 1_000_000n);
    const when = new Date(Date.now() + 6 * 60000);
    await scheduler.tick(when);
    expect(await paymentRows()).toHaveLength(0);
    expect((await texts()).at(-1)).toMatch(/needs 10.00 USDC and your wallet has 1.00 USDC.*try again/);
    expect((await schedules.get(user.id, group.items[0]!.id))!.attempts).toBe(1);

    await dealUsdc(wallet, 20_000_000n);
    await scheduler.tick(new Date(when.getTime() + DAY + 60000));
    expect(await usdcBalance(RECIPIENT)).toBe(10_000_000n);
  });

  it('the contract refuses a spend above the approved limit, even if our code asks for it', async () => {
    const group = await live([usdcItem('1', inMinutes(5))]);
    const permission = group.items[0]!.permission as Parameters<Chain['spendAndForward']>[0];
    await expect(chain.spendAndForward(permission, 1_000_001, RECIPIENT)).rejects.toThrow();
    expect(await usdcBalance(wallet)).toBe(50_000_000n);
  });

  it('after cancelling, the contract refuses too, so a misbehaving server cannot spend', async () => {
    const group = await live([usdcItem('1', monthly)]);
    const { calls } = await schedules.cancel(user.id, group.items[0]!.id);
    await walletSend(KEYS.user, wallet, calls);
    const permission = group.items[0]!.permission as Parameters<Chain['spendAndForward']>[0];
    await expect(chain.spendAndForward(permission, 1_000_000, RECIPIENT)).rejects.toThrow();
    expect(await usdcBalance(wallet)).toBe(50_000_000n);
  });

  it('monthly: pays, refuses a second spend in the same period, and pays again next period', async () => {
    const group = await live([usdcItem('1', monthly)]);
    const permission = group.items[0]!.permission as Parameters<Chain['spendAndForward']>[0];
    await chain.spendAndForward(permission, 1_000_000, RECIPIENT);
    await expect(chain.spendAndForward(permission, 1, RECIPIENT)).rejects.toThrow();
    await chainTest.increaseTime({ seconds: 28 * 86400 + 60 });
    await chainTest.mine({ blocks: 1 });
    await chain.spendAndForward(permission, 1_000_000, RECIPIENT);
    expect(await usdcBalance(RECIPIENT)).toBe(2_000_000n);
  });

  it('an expired permission asks the user to set it up again rather than failing silently', async () => {
    const group = await live([usdcItem('1', inMinutes(5))]);
    await pool.query("update schedules set permission = jsonb_set(permission, '{end}', '1') where id = $1", [group.items[0]!.id]);
    await scheduler.tick(new Date(Date.now() + 6 * 60000));
    expect((await texts()).at(-1)).toMatch(/approval has ended/);
    expect(await paymentRows()).toHaveLength(0);
  });
});
