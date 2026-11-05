import { ChildProcess } from 'node:child_process';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { Address } from 'viem';
import { CrossChain, CrossChainState, SendRequest } from '../../src/agent-api/cross-chain';
import { configureApp, createAdapter } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { ContactsService } from '../../src/contacts/contacts.service';
import { applyMigrations } from '../../src/database/migrate';
import { User } from '../../src/database/schema';
import { IdentityProvider } from '../../src/identity/identity-provider';
import { FundingService } from '../../src/payments/funding.service';
import { PaymentEngine } from '../../src/payments/payment-engine.service';
import { PlanRefused, PlansService } from '../../src/plans/plans.service';
import { SwitchesService } from '../../src/ops/switches.service';
import { UsersRepository } from '../../src/users/users.repository';
import { dealUsdc, KEYS, address, smartWallet, startFork, test as chain, usdcBalance, walletSend } from './fork';

const ARBITRUM_FRIEND = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DEPOSIT = '0x000000000000000000000000000000000000bEEF' as Address;

class FakeIdentity extends IdentityProvider {
  async verify(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeRoute extends CrossChain {
  sends: SendRequest[] = [];
  state: CrossChainState = { status: 'moving', transactions: [] };
  refuse: string | null = null;
  async priceCheck(): Promise<never> {
    throw new Error('not used');
  }
  async quote(): Promise<never> {
    throw new Error('not used');
  }
  async sendFromBase(request: SendRequest) {
    if (this.refuse) throw new Error(this.refuse);
    this.sends.push(request);
    return { depositAddress: request.dry ? null : DEPOSIT, receiverMinor: request.usdcMinor - 5_000, seconds: 34 };
  }
  async status() {
    return this.state;
  }
}

// Real USDC on a local copy of Base Sepolia, real database, real services. Only the other chain is scripted.
describe('USDC to another chain, on a fork of Base Sepolia', () => {
  let anvil: ChildProcess;
  let app: NestFastifyApplication;
  let pool: Pool;
  let plans: PlansService;
  let contacts: ContactsService;
  let funding: FundingService;
  let engine: PaymentEngine;
  let wallet: Address;
  let user: User;
  const route = new FakeRoute();

  /** Through to the point where the USDC has left the wallet. */
  async function sent(amount = '5') {
    const friend = await contacts.propose(user.id, 'Friend', [], { kind: 'wallet', walletAddress: ARBITRUM_FRIEND, chain: 'arbitrum' });
    await contacts.confirm(user.id, friend.id);
    const plan = await plans.propose(user.id, [{ route: 'usdc', destinationId: friend.destinations[0]!.id, amountNaira: null, amountUsdc: amount, dataPlanId: null }]);
    const approved = await plans.approve(user, plan.id);
    await funding.confirm(user.id, plan.id, await walletSend(KEYS.user, wallet, approved.calls));
    return plan.id;
  }
  const paymentOf = async (planId: string) => (await plans.get(user.id, planId)).items[0]!.payment!;
  const notices = async () => (await pool.query(`select content from chat_messages where user_id = $1 order by created_at`, [user.id])).rows.map((row) => row.content as string);

  beforeAll(async () => {
    anvil = await startFork();
    await applyMigrations(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).overrideProvider(CrossChain).useValue(route).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    plans = app.get(PlansService, { strict: false });
    contacts = app.get(ContactsService, { strict: false });
    funding = app.get(FundingService, { strict: false });
    engine = app.get(PaymentEngine, { strict: false });
    for (const key of Object.values(KEYS)) await chain.setBalance({ address: address(key), value: 10n ** 19n });
    wallet = await smartWallet(KEYS.user);
  }, 180000);

  beforeEach(async () => {
    await pool.query('TRUNCATE users, funding_transactions, chain_cursors CASCADE');
    user = await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:fork:cross', email: null, walletAddress: wallet });
    await dealUsdc(wallet, 50_000_000n);
    await dealUsdc(DEPOSIT, 0n);
    route.sends = [];
    route.state = { status: 'moving', transactions: [] };
    route.refuse = null;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    anvil?.kill();
  });

  it('sends real USDC to the one-time address, and does not say Paid until it has arrived', async () => {
    const id = await sent();
    expect(await usdcBalance(DEPOSIT)).toBe(5_000_000n);
    expect(await usdcBalance(wallet)).toBe(45_000_000n);
    expect(route.sends.at(-1)).toMatchObject({ dry: false, usdcMinor: 5_000_000, recipient: ARBITRUM_FRIEND, refundTo: wallet });
    expect((await paymentOf(id)).status).toBe('paying');
    await engine.reconcile();
    expect((await paymentOf(id)).status).toBe('paying');
    route.state = { status: 'delivered', transactions: ['0xbase', '0xarbitrum'] };
    await engine.reconcile();
    expect(await paymentOf(id)).toMatchObject({ status: 'completed', providerReference: '0xarbitrum' });
    expect((await notices()).join()).toContain('reached Friend on Arbitrum');
    await engine.reconcile();
    expect((await notices()).filter((text) => text.includes('reached Friend'))).toHaveLength(1);
  });

  it('says so when NEAR Intents refunded it', async () => {
    const id = await sent();
    route.state = { status: 'refunded', transactions: [] };
    await engine.reconcile();
    expect((await paymentOf(id)).status).toBe('returned');
    expect((await notices()).join()).toContain('sent back to your wallet');
  });

  it('asks for a person when delivery fails, or takes over a day, and never sends again', async () => {
    const failed = await sent('1');
    route.state = { status: 'failed', transactions: [] };
    await engine.reconcile();
    expect((await paymentOf(failed)).status).toBe('needs_support');
    route.state = { status: 'moving', transactions: [] };
    const late = await sent('2');
    await pool.query(`update payments set created_at = now() - interval '2 days' where status = 'paying'`);
    await engine.reconcile();
    expect((await paymentOf(late)).status).toBe('needs_support');
    expect((await notices()).join()).toContain('do not send it again');
    expect(route.sends.filter((item) => !item.dry)).toHaveLength(2);
  });

  it('asks no route at all for a Base address', async () => {
    const base = await contacts.propose(user.id, 'Base friend', [], { kind: 'wallet', walletAddress: ARBITRUM_FRIEND });
    await contacts.confirm(user.id, base.id);
    const plan = await plans.propose(user.id, [{ route: 'usdc', destinationId: base.destinations[0]!.id, amountNaira: null, amountUsdc: '1', dataPlanId: null }]);
    const approved = await plans.approve(user, plan.id);
    await funding.confirm(user.id, plan.id, await walletSend(KEYS.user, wallet, approved.calls));
    expect((await paymentOf(plan.id)).status).toBe('completed');
    expect(route.sends).toHaveLength(0);
  });

  it('refuses before the wallet is asked to sign when the route closes, and when paused', async () => {
    const friend = await contacts.propose(user.id, 'Friend', [], { kind: 'wallet', walletAddress: ARBITRUM_FRIEND, chain: 'arbitrum' });
    await contacts.confirm(user.id, friend.id);
    const item = { route: 'usdc' as const, destinationId: friend.destinations[0]!.id, amountNaira: null, amountUsdc: '1', dataPlanId: null };
    const plan = await plans.propose(user.id, [item]);
    route.refuse = 'Quoting for this pair is not available';
    await expect(plans.approve(user, plan.id)).rejects.toThrow('not available right now');
    expect(await usdcBalance(wallet)).toBe(50_000_000n);
    route.refuse = null;
    const switches = app.get(SwitchesService, { strict: false });
    await switches.set('usdc_other_chains', true);
    try {
      await expect(plans.propose(user.id, [item])).rejects.toBeInstanceOf(PlanRefused);
    } finally {
      await switches.set('usdc_other_chains', false);
    }
  });
});
