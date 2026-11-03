import { ChildProcess } from 'node:child_process';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { configureApp, createAdapter } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { ContactsService } from '../../src/contacts/contacts.service';
import { applyMigrations } from '../../src/database/migrate';
import { User } from '../../src/database/schema';
import { IdentityProvider } from '../../src/identity/identity-provider';
import { DepositsService } from '../../src/payments/deposits.service';
import { FundingService } from '../../src/payments/funding.service';
import { PlanRefused, PlansService } from '../../src/plans/plans.service';
import { UsersRepository } from '../../src/users/users.repository';
import { address, dealUsdc, eoa, KEYS, smartWallet, startFork, test, usdcBalance, USDC, walletSend } from './fork';
import { parseAbi } from 'viem';

const COLLECTION = address(KEYS.collection);
const RECIPIENT = '0x000000000000000000000000000000000000dEaD' as Address;

class FakeIdentity extends IdentityProvider {
  async verify(): Promise<never> {
    throw new Error('not used');
  }
}

// Real contracts on a local copy of Base Sepolia, real database, real services. Only the user's signature is scripted.
describe('USDC payments on a fork of Base Sepolia', () => {
  let anvil: ChildProcess;
  let app: NestFastifyApplication;
  let pool: Pool;
  let plans: PlansService;
  let contacts: ContactsService;
  let funding: FundingService;
  let deposits: DepositsService;
  let wallet: Address;
  let user: User;

  async function saved(name: string, destination: Parameters<ContactsService['propose']>[3]) {
    const contact = await contacts.propose(user.id, name, [], destination);
    await contacts.confirm(user.id, contact.id);
    return contact.destinations[0]!;
  }
  const usdcItem = (destinationId: string, amountUsdc: string) => ({ route: 'usdc' as const, destinationId, amountNaira: null, amountUsdc, dataPlanId: null });
  const bankItem = (destinationId: string, amountNaira: number) => ({ route: 'bank' as const, destinationId, amountNaira, amountUsdc: null, dataPlanId: null });
  const airtimeItem = (destinationId: string, amountNaira: number) => ({ route: 'airtime' as const, destinationId, amountNaira, amountUsdc: null, dataPlanId: null });

  beforeAll(async () => {
    anvil = await startFork();
    await applyMigrations(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    plans = app.get(PlansService, { strict: false });
    contacts = app.get(ContactsService, { strict: false });
    funding = app.get(FundingService, { strict: false });
    deposits = app.get(DepositsService, { strict: false });
    for (const key of Object.values(KEYS)) await test.setBalance({ address: address(key), value: 10n ** 19n });
    wallet = await smartWallet(KEYS.user);
  }, 180000);

  beforeEach(async () => {
    await pool.query('TRUNCATE users, funding_transactions, chain_cursors CASCADE');
    user = await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:fork:user', email: null, walletAddress: wallet });
    await dealUsdc(wallet, 50_000_000n);
    await dealUsdc(COLLECTION, 0n);
    await dealUsdc(RECIPIENT, 0n);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    anvil?.kill();
  });

  it('moves real USDC for a mixed plan with one signature', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const kc = await saved('Kc', { kind: 'phone', phone: '08031234567' });
    const mum = await saved('Mother', { kind: 'bank', bankName: 'GTBank', accountNumber: '0123456789' });
    const plan = await plans.propose(user.id, [usdcItem(halima.id, '2.5'), airtimeItem(kc.id, 150), bankItem(mum.id, 1500)]);

    const approved = await plans.approve(user, plan.id);
    expect(approved.items.map((item) => item.payment!.status)).toEqual(['awaiting_signature', 'awaiting_signature', 'awaiting_signature']);
    expect(approved.calls).toHaveLength(3);
    expect(await usdcBalance(wallet)).toBe(50_000_000n); // nothing moves before the signature

    const hash = await walletSend(KEYS.user, wallet, approved.calls);
    await funding.confirm(user.id, plan.id, hash);

    const done = await plans.get(user.id, plan.id);
    expect(done.items.map((item) => item.payment!.status)).toEqual(['completed', 'completed', 'completed']);
    expect(await usdcBalance(RECIPIENT)).toBe(2_500_000n);
    expect(await usdcBalance(COLLECTION)).toBe(1_100_000n); // 0.1 for N150 and 1 for N1,500 at N1,500 per USDC
    expect(await usdcBalance(wallet)).toBe(50_000_000n - 3_600_000n);
  });

  it('refuses before signing when the wallet does not hold enough', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const plan = await plans.propose(user.id, [usdcItem(halima.id, '51')]);
    await expect(plans.approve(user, plan.id)).rejects.toThrow(/You need 51.00 USDC but your wallet has 50.00 USDC/);
  });

  it('refuses a transaction that did not pay the right amount, and it can still be signed correctly', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const plan = await plans.propose(user.id, [usdcItem(halima.id, '5')]);
    const approved = await plans.approve(user, plan.id);

    const other = await plans.propose(user.id, [usdcItem(halima.id, '1')]);
    const otherApproved = await plans.approve(user, other.id);
    const cheap = await walletSend(KEYS.user, wallet, otherApproved.calls);

    await expect(funding.confirm(user.id, plan.id, cheap)).rejects.toThrow(PlanRefused);
    expect((await plans.get(user.id, plan.id)).items[0]!.payment!.status).toBe('awaiting_signature');

    const right = await walletSend(KEYS.user, wallet, approved.calls);
    await funding.confirm(user.id, plan.id, right);
    expect((await plans.get(user.id, plan.id)).items[0]!.payment!.status).toBe('completed');
  });

  it('never lets one transaction pay for two plans, or count twice', async () => {
    const kc = await saved('Kc', { kind: 'phone', phone: '08031234567' });
    const first = await plans.approve(user, (await plans.propose(user.id, [airtimeItem(kc.id, 1500)])).id);
    const second = await plans.approve(user, (await plans.propose(user.id, [airtimeItem(kc.id, 1500)])).id);
    const hash = await walletSend(KEYS.user, wallet, first.calls);

    await funding.confirm(user.id, first.id, hash);
    await expect(funding.confirm(user.id, second.id, hash)).rejects.toThrow(/already used/);
    await funding.confirm(user.id, first.id, hash); // the same plan again changes nothing
    expect((await plans.get(user.id, second.id)).items[0]!.payment!.status).toBe('awaiting_signature');
    expect(await usdcBalance(COLLECTION)).toBe(1_000_000n);
  });

  it("refuses another person's transaction with the same amount and address", async () => {
    const kc = await saved('Kc', { kind: 'phone', phone: '08031234567' });
    const plan = await plans.approve(user, (await plans.propose(user.id, [airtimeItem(kc.id, 1500)])).id);
    const stranger = eoa(KEYS.attacker);
    await dealUsdc(stranger.account.address, 5_000_000n);
    const hash = await stranger.writeContract({
      address: USDC,
      abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
      functionName: 'transfer',
      args: [COLLECTION, 1_000_000n],
    });
    await expect(funding.confirm(user.id, plan.id, hash)).rejects.toThrow(/does not match/);
  });

  it('returns the USDC when delivery fails', async () => {
    const failing = await saved('Bad', { kind: 'bank', bankName: 'GTBank', accountNumber: '1234560000' }); // simulated bank refuses 0000
    const plan = await plans.approve(user, (await plans.propose(user.id, [bankItem(failing.id, 3000)])).id);
    const hash = await walletSend(KEYS.user, wallet, plan.calls);
    expect(await usdcBalance(wallet)).toBe(48_000_000n);

    await funding.confirm(user.id, plan.id, hash);

    const done = await plans.get(user.id, plan.id);
    expect(done.items[0]!.payment!.status).toBe('returned');
    expect(done.items[0]!.payment!.refundTxHash).toBeTruthy();
    expect(await usdcBalance(wallet)).toBe(50_000_000n);
    const { rows } = await pool.query('select content from chat_messages where user_id = $1', [user.id]);
    expect(rows.some((row) => /went back to your wallet/.test(row.content))).toBe(true);
  });

  it('finishes the job when the browser closed after the wallet sent the transaction', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const plan = await plans.approve(user, (await plans.propose(user.id, [usdcItem(halima.id, '3')])).id);
    await walletSend(KEYS.user, wallet, plan.calls);
    await pool.query("update payments set created_at = now() - interval '20 minutes'");
    await funding.reconcile();
    expect((await plans.get(user.id, plan.id)).items[0]!.payment!.status).toBe('completed');
  });

  it('drops an unsigned payment after the window, so it stops counting against the limit', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const plan = await plans.approve(user, (await plans.propose(user.id, [usdcItem(halima.id, '3')])).id);
    await pool.query("update payments set created_at = now() - interval '20 minutes'");
    await funding.reconcile();
    const done = await plans.get(user.id, plan.id);
    expect(done.items[0]!.payment!.status).toBe('failed');
    expect(await usdcBalance(wallet)).toBe(50_000_000n);
  });

  it('marks a reverted transaction failed', async () => {
    const halima = await saved('Halima', { kind: 'wallet', walletAddress: RECIPIENT });
    const plan = await plans.approve(user, (await plans.propose(user.id, [usdcItem(halima.id, '3')])).id);
    // The balance is gone by the time the wallet sends, so the transfer reverts inside the batch.
    await dealUsdc(wallet, 0n);
    const hash = await walletSend(KEYS.user, wallet, plan.calls, 500000n);
    await funding.confirm(user.id, plan.id, hash);
    const payment = (await plans.get(user.id, plan.id)).items[0]!.payment!;
    expect(payment.status).toBe('failed');
    expect(payment.failureReason).toMatch(/nothing moved/);
  });

  it('announces a deposit exactly once', async () => {
    await deposits.watch(); // sets the starting point
    const stranger = eoa(KEYS.attacker);
    await dealUsdc(stranger.account.address, 9_000_000n);
    await stranger.writeContract({ address: USDC, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [wallet, 4_250_000n] });
    expect(await deposits.watch()).toBe(1);
    await pool.query("delete from chain_cursors");
    await deposits.watch();
    const { rows } = await pool.query("select content from chat_messages where user_id = $1 and content like 'You received%'", [user.id]);
    // Refunds from the collection address have their own message, so they are not announced here too.
    expect(rows.map((row) => row.content)).toEqual(['You received 4.25 USDC in your wallet.']);
  });
});
