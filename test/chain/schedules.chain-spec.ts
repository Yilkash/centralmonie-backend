import { ChildProcess } from 'node:child_process';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { configureApp, createAdapter } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { generatePrivateKey } from 'viem/accounts';
import { Chain, SpendRefused, ViemChain } from '../../src/chain/chain.service';
import { approvePermissionCall } from '../../src/chain/chain.service';
import { FakeBundler } from './fake-bundler';
import { ContactsService } from '../../src/contacts/contacts.service';
import { applyMigrations } from '../../src/database/migrate';
import { User } from '../../src/database/schema';
import { IdentityProvider } from '../../src/identity/identity-provider';
import { SchedulerService } from '../../src/schedules/scheduler.service';
import { ProposedSchedule, SchedulesService } from '../../src/schedules/schedules.service';
import { Timing } from '../../src/schedules/timing';
import { UsersRepository } from '../../src/users/users.repository';
import { address, dealUsdc, KEYS, RPC, smartWallet, startFork, syncClock, test as chainTest, USDC, usdcBalance, walletSend } from './fork';

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

  it('a transaction with an unknown outcome is never sent again', async () => {
    const group = await live([usdcItem('2', monthly)]);
    const id = group.items[0]!.id;
    const due = (await schedules.get(user.id, id))!.nextRunAt!;
    const spend = chain.spendAndForward.bind(chain);
    jest.spyOn(chain, 'spendAndForward').mockImplementationOnce(async (...args) => {
      await spend(...args); // it really goes out, then the wait for the result fails
      throw new Error('receipt timed out');
    });
    const when = new Date(due.getTime() + 60000);
    await scheduler.tick(when);
    expect((await paymentRows())[0]!.status).toBe('needs_support');
    expect(await usdcBalance(RECIPIENT)).toBe(2_000_000n);
    expect((await texts()).at(-1)).toMatch(/could not confirm/);

    await scheduler.tick(new Date(when.getTime() + 1000));
    expect(await usdcBalance(RECIPIENT)).toBe(2_000_000n);
    expect(await paymentRows()).toHaveLength(1);
  });

  it('a permission for limited runs ends soon after the last one', async () => {
    const group = await live([usdcItem('1', { ...monthly, occurrences: 2 } as Timing)]);
    const permission = group.items[0]!.permission as { start: number; end: number };
    expect(permission.end - permission.start).toBe(2 * 28 * 86400 + 7 * 86400);
  });

  it('a finished schedule still offers a way to remove its permission', async () => {
    const group = await live([usdcItem('1', inMinutes(5))]);
    await scheduler.tick(new Date(Date.now() + 6 * 60000));
    const { calls } = await schedules.cancel(user.id, group.items[0]!.id);
    expect(calls).toHaveLength(1);
  });

  it('an expired permission asks the user to set it up again rather than failing silently', async () => {
    const group = await live([usdcItem('1', inMinutes(5))]);
    await pool.query("update schedules set permission = jsonb_set(permission, '{end}', '1') where id = $1", [group.items[0]!.id]);
    await scheduler.tick(new Date(Date.now() + 6 * 60000));
    expect((await texts()).at(-1)).toMatch(/approval has ended/);
    expect(await paymentRows()).toHaveLength(0);
  });

  describe('through a bundler, so a paymaster pays the gas', () => {
    // Brand new every run, so its account really has never been deployed.
    const OWNER = generatePrivateKey();
    let bundler: FakeBundler;
    let sponsored: ViemChain;
    let spender: Address;

    /** A permission to a server account that has never been deployed and has no way to pay for itself but its deposit. */
    async function permissionFor(amount: string) {
      const proposed = await schedules.propose(user.id, [usdcItem(amount, monthly)]);
      const { items } = await schedules.approve(user, proposed.groupId);
      const permission = { ...(items[0]!.permission as Parameters<Chain['spendAndForward']>[0]), spender };
      await walletSend(KEYS.user, wallet, [approvePermissionCall(permission)]);
      return permission;
    }

    beforeAll(async () => {
      bundler = new FakeBundler(KEYS.collection, 18546);
      await bundler.start();
      const settings: Record<string, unknown> = {
        CHAIN_RPC_URL: RPC,
        CHAIN_ID: 84532,
        USDC_ADDRESS: USDC,
        SERVER_OWNER_KEY: OWNER,
        SERVER_BUNDLER_URL: bundler.url,
        COLLECTION_KEY: KEYS.collection,
      };
      sponsored = new ViemChain({ get: (name: string) => settings[name] } as never);
      spender = (await sponsored.spender()) as Address;
      // The fake bundler has no paymaster, so the account's own deposit stands in for it. The owner key stays empty.
      await chainTest.setBalance({ address: spender, value: 10n ** 18n });
      await chainTest.setBalance({ address: address(OWNER), value: 0n });
    });

    afterAll(() => bundler.stop());

    beforeEach(() => {
      bundler.refusePaymaster = false;
      bundler.refuseSend = false;
    });

    it('deploys the account and pays in one operation, with no ETH on the owner key', async () => {
      expect(await chainTest.getCode({ address: spender })).toBeUndefined();
      const permission = await permissionFor('1');
      const before = await usdcBalance(RECIPIENT);
      const seen: string[] = [];
      const hash = await sponsored.spendAndForward(permission, 1_000_000, RECIPIENT, async (sent) => void seen.push(sent));
      expect(await usdcBalance(RECIPIENT)).toBe(before + 1_000_000n);
      expect(seen).toEqual([hash]);
      expect(await chainTest.getCode({ address: spender })).toBeDefined();
      expect(await chainTest.getBalance({ address: address(OWNER) })).toBe(0n);
    });

    it('says nothing moved when the permission or the paymaster refuses', async () => {
      const permission = await permissionFor('1');
      const before = await usdcBalance(RECIPIENT);
      await expect(sponsored.spendAndForward(permission, 1_000_001, RECIPIENT)).rejects.toBeInstanceOf(SpendRefused);
      bundler.refusePaymaster = true;
      await expect(sponsored.spendAndForward(permission, 1_000_000, RECIPIENT)).rejects.toBeInstanceOf(SpendRefused);
      expect(await usdcBalance(RECIPIENT)).toBe(before);
    });

    it('treats trouble at the send as doubt, never as nothing sent', async () => {
      const permission = await permissionFor('1');
      bundler.refuseSend = true;
      const failure = await sponsored.spendAndForward(permission, 1_000_000, RECIPIENT).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(SpendRefused);
    });
  });
});
