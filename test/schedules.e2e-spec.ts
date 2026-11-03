import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { User } from '../src/database/schema';
import { IdentityProvider, InvalidIdentityError } from '../src/identity/identity-provider';
import { SwitchesService } from '../src/ops/switches.service';
import { ExchangeRates } from '../src/providers/providers';
import { PlanRefused } from '../src/plans/plan-refused';
import { SchedulerService } from '../src/schedules/scheduler.service';
import { ProposedSchedule, SchedulesService } from '../src/schedules/schedules.service';
import { Timing } from '../src/schedules/timing';
import { UsersRepository } from '../src/users/users.repository';

class FakeIdentity extends IdentityProvider {
  async verify(token: string) {
    if (!['alice', 'bob'].includes(token)) throw new InvalidIdentityError('bad');
    return { subject: `did:privy:${token}`, email: null, walletAddress: null };
  }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const inMinutes = (delayMinutes: number): Timing => ({ kind: 'once', delayMinutes, date: null, time: null });
const monthly: Timing = { kind: 'recurring', frequency: 'monthly', interval: 1, weekday: null, dayOfMonth: null, lastDayOfMonth: false, time: null, occurrences: null, startDate: null };

// Simulated money, real database, real scheduler, with time passed in by hand.
describe('scheduled payments', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let schedules: SchedulesService;
  let scheduler: SchedulerService;
  let contacts: ContactsService;
  let switches: SwitchesService;
  let alice: User;
  let bob: User;

  async function destination(user: User, name: string, details: Parameters<ContactsService['propose']>[3]) {
    const contact = await contacts.propose(user.id, name, [], details);
    await contacts.confirm(user.id, contact.id);
    return contact.destinations[0]!.id;
  }
  const bankTo = (user = alice, accountNumber = '0123454821') => destination(user, 'Mother', { kind: 'bank', bankName: 'Access', accountNumber });
  const item = (destinationId: string, amountNaira: number, timing: Timing): ProposedSchedule => ({ route: 'bank', destinationId, amountNaira, amountUsdc: null, dataPlanId: null, timing });
  const texts = async (user: User) => (await pool.query('select content from chat_messages where user_id = $1 order by created_at', [user.id])).rows.map((row) => row.content as string);
  const paymentRows = async (user: User) => (await pool.query('select amount_kobo, status from payments where user_id = $1', [user.id])).rows;
  const later = (ms: number) => new Date(Date.now() + ms);

  beforeAll(async () => {
    await applyMigrations(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IdentityProvider).useClass(FakeIdentity).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    schedules = app.get(SchedulesService, { strict: false });
    scheduler = app.get(SchedulerService, { strict: false });
    contacts = app.get(ContactsService, { strict: false });
    switches = app.get(SwitchesService, { strict: false });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, op_switches CASCADE');
    const users = app.get(UsersRepository, { strict: false });
    alice = await users.upsert({ subject: 'did:privy:alice', email: null, walletAddress: null });
    bob = await users.upsert({ subject: 'did:privy:bob', email: null, walletAddress: null });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('counts "in 30 minutes" from approval, and pays once when due', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 5000, inMinutes(30))]);
    expect(group.items[0]!.nextRunAt).toBeNull();
    await pool.query("update schedules set created_at = now() - interval '10 minutes'");

    const approved = await schedules.approve(alice, group.groupId);
    const runAt = approved.items[0]!.nextRunAt!;
    expect(Math.abs(runAt.getTime() - (Date.now() + 30 * MINUTE))).toBeLessThan(5000);

    await scheduler.tick(later(29 * MINUTE));
    expect(await paymentRows(alice)).toHaveLength(0);

    await scheduler.tick(later(31 * MINUTE));
    expect(await paymentRows(alice)).toEqual([{ amount_kobo: '500000', status: 'completed' }]);
    expect((await schedules.get(alice.id, group.items[0]!.id))!.status).toBe('completed');
    expect((await texts(alice)).at(-1)).toMatch(/Scheduled payment sent, as you approved: ₦5,000 bank transfer to Mother/);

    await scheduler.tick(later(2 * DAY));
    expect(await paymentRows(alice)).toHaveLength(1);
  });

  it('never runs without approval', async () => {
    await schedules.propose(alice.id, [item(await bankTo(), 5000, inMinutes(1))]);
    await scheduler.tick(later(DAY));
    expect(await paymentRows(alice)).toHaveLength(0);
  });

  it('never runs after rejection, and a proposal expires', async () => {
    const destinationId = await bankTo();
    const rejected = await schedules.propose(alice.id, [item(destinationId, 5000, inMinutes(1))]);
    await schedules.reject(alice.id, rejected.groupId);
    await expect(schedules.approve(alice, rejected.groupId)).rejects.toThrow(/already been decided/);

    const old = await schedules.propose(alice.id, [item(destinationId, 5000, inMinutes(1))]);
    await pool.query("update schedules set expires_at = now() - interval '1 minute' where group_id = $1", [old.groupId]);
    await expect(schedules.approve(alice, old.groupId)).rejects.toThrow(PlanRefused);
    await scheduler.tick(later(DAY));
    expect(await paymentRows(alice)).toHaveLength(0);
  });

  it("cannot touch another user's schedule or use their contact", async () => {
    const destinationId = await bankTo();
    const group = await schedules.propose(alice.id, [item(destinationId, 5000, inMinutes(1))]);
    await expect(schedules.approve(bob, group.groupId)).rejects.toThrow(/not found/i);
    await expect(schedules.cancel(bob.id, group.items[0]!.id)).rejects.toThrow(/not found/i);
    await expect(schedules.propose(bob.id, [item(destinationId, 5000, inMinutes(1))])).rejects.toThrow(/not one of the saved contacts/);
  });

  it('refuses an amount that could never run, and a bad date', async () => {
    const destinationId = await bankTo();
    await expect(schedules.propose(alice.id, [item(destinationId, 500_001, inMinutes(5))])).rejects.toThrow(/daily limit/);
    await expect(schedules.propose(alice.id, [item(destinationId, 5000, { ...monthly, dayOfMonth: 31 } as Timing)])).rejects.toThrow(/last day of each month/);
    await expect(schedules.propose(alice.id, [item(destinationId, 5000, { kind: 'once', delayMinutes: null, date: '2020-01-01', time: null })])).rejects.toThrow(/passed/);
  });

  it('repeats monthly from the same date, and limited runs stop', async () => {
    const limited = { ...monthly, occurrences: 2 } as Timing;
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, limited)]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const first = (await schedules.get(alice.id, id))!.nextRunAt!;
    await scheduler.tick(new Date(first.getTime() + MINUTE));
    const second = (await schedules.get(alice.id, id))!;
    expect(second.status).toBe('active');
    expect(second.nextRunAt!.getUTCDate()).toBe(28);
    expect(second.nextRunAt!.getTime()).toBeGreaterThan(first.getTime());
    await scheduler.tick(new Date(second.nextRunAt!.getTime() + MINUTE));
    expect((await schedules.get(alice.id, id))!.status).toBe('completed');
    expect(await paymentRows(alice)).toHaveLength(2);
  });

  it('does not pay several missed months at once after downtime', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, monthly)]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const first = (await schedules.get(alice.id, id))!.nextRunAt!;
    const muchLater = new Date(first.getTime() + 100 * DAY);
    await scheduler.tick(muchLater);
    await scheduler.tick(muchLater);
    expect(await paymentRows(alice)).toHaveLength(1);
    expect((await schedules.get(alice.id, id))!.nextRunAt!.getTime()).toBeGreaterThan(muchLater.getTime());
  });

  it('on failure: nothing sent, the user is told, and it retries the next day', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(alice, '1234560000'), 1000, inMinutes(1))]); // simulated bank refuses 0000
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const due = later(2 * MINUTE);
    await scheduler.tick(due);

    const after = (await schedules.get(alice.id, id))!;
    expect(after.status).toBe('active');
    expect(after.attempts).toBe(1);
    expect(after.nextRunAt!.getTime()).toBe(due.getTime() + DAY);
    expect((await texts(alice)).at(-1)).toMatch(/did not go out.*try again/);
    expect((await paymentRows(alice))[0]!.status).toBe('failed');

    // Three retries, then it stops, and each failed day told the user.
    for (const day of [1, 2, 3]) await scheduler.tick(new Date(due.getTime() + day * DAY + MINUTE));
    const stopped = (await schedules.get(alice.id, id))!;
    expect(stopped.status).toBe('failed');
    expect((await texts(alice)).at(-1)).toMatch(/so I have stopped/);
    expect(await paymentRows(alice)).toHaveLength(4);
    await scheduler.tick(new Date(due.getTime() + 10 * DAY));
    expect(await paymentRows(alice)).toHaveLength(4);
  });

  it('respects the daily limit shared with other payments', async () => {
    const destinationId = await bankTo();
    const group = await schedules.propose(alice.id, [item(destinationId, 400_000, inMinutes(1)), item(destinationId, 200_000, inMinutes(1))]);
    await schedules.approve(alice, group.groupId);
    await scheduler.tick(later(2 * MINUTE));
    const rows = await paymentRows(alice);
    expect(rows).toHaveLength(1); // both together would pass the limit, so only one of them runs today
    expect(rows[0]!.status).toBe('completed');
    expect((await texts(alice)).join(' ')).toMatch(/would pass your ₦500,000 daily limit/);
  });

  it('stops at once when cancelled', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const { schedule } = await schedules.cancel(alice.id, id);
    expect(schedule.status).toBe('cancelled');
    await scheduler.tick(later(DAY));
    expect(await paymentRows(alice)).toHaveLength(0);
    await expect(schedules.cancel(alice.id, id)).resolves.toBeDefined(); // repeating it is harmless
  });

  it('holds everything under the pause switch, and runs after it lifts', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    await schedules.approve(alice, group.groupId);
    await switches.set('schedules', true);
    await scheduler.tick(later(5 * MINUTE));
    expect(await paymentRows(alice)).toHaveLength(0);
    await switches.set('schedules', false);
    await scheduler.tick(later(6 * MINUTE));
    expect(await paymentRows(alice)).toHaveLength(1);
  });

  it('cannot pay a due moment twice, even if two passes overlap or a crash repeats it', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, monthly)]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const due = (await schedules.get(alice.id, id))!.nextRunAt!;
    const when = new Date(due.getTime() + MINUTE);
    await Promise.all([scheduler.tick(when), scheduler.tick(when), scheduler.tick(when)]);
    expect(await paymentRows(alice)).toHaveLength(1);

    // As if the server died after the payment but before moving the date on.
    await pool.query('update schedules set next_run_at = $1, scheduled_for = $1, lease_until = null where id = $2', [due, id]);
    await scheduler.tick(when);
    expect(await paymentRows(alice)).toHaveLength(1);
    expect((await schedules.get(alice.id, id))!.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
  });

  it('cancelling after a run was claimed still stops the payment', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const claim = schedules.claimDue.bind(schedules);
    jest.spyOn(schedules, 'claimDue').mockImplementationOnce(async (...args) => {
      const claimed = await claim(...args);
      await schedules.cancel(alice.id, id);
      return claimed;
    });
    await scheduler.tick(later(5 * MINUTE));
    expect(await paymentRows(alice)).toHaveLength(0);
    expect((await schedules.get(alice.id, id))!.status).toBe('cancelled');
  });

  it('a temporary problem is a failed try that gets retried, not a lost payment', async () => {
    const rates = app.get(ExchangeRates, { strict: false });
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    jest.spyOn(rates, 'nairaPerUsdc').mockRejectedValueOnce(new Error('partner down'));
    const due = later(2 * MINUTE);
    await scheduler.tick(due);
    const after = (await schedules.get(alice.id, id))!;
    expect(after.status).toBe('active');
    expect(after.attempts).toBe(1);
    await scheduler.tick(new Date(due.getTime() + DAY + MINUTE));
    expect(await paymentRows(alice)).toHaveLength(1);
    expect((await schedules.get(alice.id, id))!.status).toBe('completed');
  });

  it('a crash before any payment row retries the same run, and still pays only once', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const due = (await schedules.get(alice.id, id))!.nextRunAt!;
    await pool.query('insert into schedule_runs (schedule_id, due_at) values ($1, $2)', [id, due]);
    await scheduler.tick(later(5 * MINUTE));
    expect(await paymentRows(alice)).toHaveLength(1);
    expect((await schedules.get(alice.id, id))!.status).toBe('completed');
  });

  it('a slow approve cannot undo a rejection', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, inMinutes(1))]);
    const results = await Promise.allSettled([schedules.approve(alice, group.groupId), schedules.reject(alice.id, group.groupId), schedules.approve(alice, group.groupId)]);
    const status = (await schedules.group(alice.id, group.groupId)).status;
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    if (status === 'rejected') {
      await scheduler.tick(later(DAY));
      expect(await paymentRows(alice)).toHaveLength(0);
    }
  });

  it('reminds a day before a long-planned payment, once', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 1000, monthly)]);
    const id = (await schedules.approve(alice, group.groupId)).items[0]!.id;
    const due = (await schedules.get(alice.id, id))!.nextRunAt!;
    await pool.query("update schedules set approved_at = now() - interval '60 days' where id = $1", [id]);
    const before = new Date(due.getTime() - 2 * 3600 * 1000);
    await scheduler.tick(before);
    await scheduler.tick(before);
    expect((await texts(alice)).filter((text) => text.startsWith('Reminder:'))).toHaveLength(1);
  });

  it('answers over HTTP, with the card and its plain wording', async () => {
    const group = await schedules.propose(alice.id, [item(await bankTo(), 5000, inMinutes(240))]);
    const list = await app.inject({ method: 'POST', url: `/v1/schedules/groups/${group.groupId}/approve`, headers: { authorization: 'Bearer alice' } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].when).toMatch(/^Once, /);
    const mine = await app.inject({ method: 'GET', url: '/v1/schedules', headers: { authorization: 'Bearer alice' } });
    expect(mine.json().schedules).toHaveLength(1);
    const theirs = await app.inject({ method: 'GET', url: '/v1/schedules', headers: { authorization: 'Bearer bob' } });
    expect(theirs.json().schedules).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/v1/schedules' })).statusCode).toBe(401);
  });
});
