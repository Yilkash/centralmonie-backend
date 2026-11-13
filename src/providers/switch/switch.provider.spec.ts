import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentRequest } from '../providers';
import {
  GENERIC_HOLDER_NAME,
  SwitchError,
  SwitchProvider,
  switchBeneficiaryName,
  verifySwitchWebhook,
  withinSwitchReplayWindow,
} from './switch.provider';

// Bodies follow Tokkenly's switch.client.ts types, test/helpers.ts FakeSwitch and its specs.
const BASE = 'https://api.onswitch.xyz';
const KEY = 'test-service-key';
const REFUND = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const WALLET = '0x3333333333333333333333333333333333333333';
const ACCOUNT = '3048915627';

type Route = () => Response | Promise<Response>;

function envelope(status: number, data: unknown, message = 'ok'): Response {
  return new Response(JSON.stringify({ success: status < 400, message, timestamp: '', data }), { status });
}
const ok = (data: unknown) => envelope(200, data);
const refused = (status: number, message: string) => envelope(status, null, message);
const down = () => Promise.reject(new TypeError('fetch failed'));

const BANKS = [
  { code: '058', name: 'Guaranty Trust Bank', country: 'NG' },
  { code: '033', name: 'United Bank for Africa', country: 'NG' },
];
const banksRoute: Route = () => ok(BANKS);

/** Offramp at N1500.50 for 20 USDC, the shape FakeSwitch.initiate gives. */
const offramp = (overrides: Record<string, unknown> = {}) => ({
  status: 'AWAITING_DEPOSIT',
  type: 'OFFRAMP',
  reference: 'ref-1',
  rate: 1500.5,
  source: { amount: 20, currency: 'USDC', network: 'BASE' },
  destination: { amount: 30010, currency: 'NGN', network: 'FIAT' },
  deposit: { amount: 20, address: DEPOSIT, expires_at: '2026-11-03T10:30:00.000Z' },
  ...overrides,
});

function partner(routes: Record<string, Route>) {
  const calls: Array<{ key: string; url: string; init: RequestInit; body: unknown }> = [];
  const fake = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method} ${new URL(String(input)).pathname}`;
    calls.push({ key, url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const route = routes[key];
    if (!route) throw new Error(`unexpected call: ${key}`);
    return route();
  });
  return {
    fetch: fake as unknown as typeof fetch,
    calls,
    count: (key: string) => calls.filter((call) => call.key === key).length,
    last: (key: string) => calls.filter((call) => call.key === key).pop()!,
  };
}

const provider = (fake: typeof fetch, extra: Partial<ConstructorParameters<typeof SwitchProvider>[0]> = {}) =>
  new SwitchProvider({ baseUrl: `${BASE}/`, apiKey: KEY, refundAddress: REFUND, fetch: fake, ...extra });

const bank = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  reference: 'ref-1',
  route: 'bank',
  destination: { bankName: 'Guaranty Trust Bank', accountNumber: ACCOUNT, accountName: 'CHINONSO ADEYEMI' },
  amountKobo: 3_001_000,
  usdcMinor: 20_000_000,
  ...overrides,
});

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe('construction', () => {
  it('needs a URL, a key and a real refund address', () => {
    expect(() => new SwitchProvider({ baseUrl: BASE, apiKey: '', refundAddress: REFUND })).toThrow('apiKey');
    expect(() => new SwitchProvider({ baseUrl: '', apiKey: KEY, refundAddress: REFUND })).toThrow('baseUrl');
    expect(() => new SwitchProvider({ baseUrl: BASE, apiKey: KEY, refundAddress: 'nope' })).toThrow('refundAddress');
  });
});

describe('SwitchError', () => {
  it.each([
    [new SwitchError('no answer', null)],
    [new SwitchError('gateway', 502)],
    [new SwitchError('rate limit', 429)],
    [new SwitchError('unreadable', 404, true)],
  ])('can ask again after %s', (err) => {
    expect(err.retryable).toBe(true);
  });

  it('acts on a readable 4xx', () => {
    expect(new SwitchError('unknown payment', 404).retryable).toBe(false);
  });
});

describe('nairaPerUsdc', () => {
  it('asks for the base USDC off-ramp rate, with the service key', async () => {
    const fake = partner({ 'POST /offramp/rate': () => ok({ rate: 1500.5 }) });

    await expect(provider(fake.fetch).nairaPerUsdc()).resolves.toBe(1500.5);

    expect(fake.calls[0]!.url).toBe(`${BASE}/offramp/rate`);
    expect(fake.calls[0]!.body).toEqual({ country: 'NG', currency: 'NGN', asset: 'base:usdc', channel: 'BANK' });
    expect((fake.calls[0]!.init.headers as Record<string, string>)['x-service-key']).toBe(KEY);
  });

  it('caches for thirty seconds, then asks again', async () => {
    const fake = partner({ 'POST /offramp/rate': () => ok({ rate: 1500.5 }) });
    let now = 1_000;
    const rates = provider(fake.fetch, { now: () => now });

    await rates.nairaPerUsdc();
    await rates.nairaPerUsdc();
    expect(fake.calls).toHaveLength(1);

    now += 30_001;
    await rates.nairaPerUsdc();
    expect(fake.calls).toHaveLength(2);
  });

  it.each([
    ['a network failure', down],
    ['a refusal', () => refused(400, 'corridor suspended')],
    ['a zero rate', () => ok({ rate: 0 })],
    ['no rate', () => ok({})],
  ] as Array<[string, Route]>)('throws on %s and caches nothing', async (_, route) => {
    const fake = partner({ 'POST /offramp/rate': route });
    await expect(provider(fake.fetch).nairaPerUsdc()).rejects.toThrow();
  });
});

describe('nairaPerUsdc in an outage', () => {
  it('keeps the recent rate for a few minutes, then says it cannot tell', async () => {
    let time = 0;
    let up = true;
    const fake = partner({ 'POST /offramp/rate': () => (up ? ok({ rate: 1400 }) : down()) });
    const switch_ = provider(fake.fetch, { now: () => time });
    await expect(switch_.nairaPerUsdc()).resolves.toBe(1400);
    up = false;
    time = 5 * 60_000;
    await expect(switch_.nairaPerUsdc()).resolves.toBe(1400);
    time = 11 * 60_000;
    await expect(switch_.nairaPerUsdc()).rejects.toThrow();
  });
});

describe('accountName', () => {
  const lookup = () => ok({ bank_code: '058', account_number: ACCOUNT, account_name: 'CHINONSO ADEYEMI' });

  it('turns the bank name into a code, then asks for the name', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /institution/lookup': lookup });

    await expect(provider(fake.fetch).accountName('guaranty  trust bank', ACCOUNT)).resolves.toBe('CHINONSO ADEYEMI');

    expect(fake.calls[0]!.url).toBe(`${BASE}/institution?country=NG&channel=BANK`);
    expect(fake.last('POST /institution/lookup').body).toEqual({
      country: 'NG',
      beneficiary: { account_number: ACCOUNT, bank_code: '058' },
    });
  });

  it('reuses the bank list', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /institution/lookup': lookup });
    const banks = provider(fake.fetch);
    await banks.accountName('Guaranty Trust Bank', ACCOUNT);
    await banks.accountName('United Bank for Africa', ACCOUNT);
    expect(fake.count('GET /institution')).toBe(1);
  });

  it('will not guess a bank from a near match', async () => {
    const fake = partner({ 'GET /institution': banksRoute });
    await expect(provider(fake.fetch).accountName('No Such Bank', ACCOUNT)).resolves.toBeNull();
    await expect(provider(fake.fetch).accountName('Guaranty', ACCOUNT)).resolves.toBeNull();
    expect(fake.count('POST /institution/lookup')).toBe(0);
  });

  it('will not choose between two banks with one name', async () => {
    const fake = partner({ 'GET /institution': () => ok([{ code: '1', name: 'Same Bank' }, { code: '2', name: 'SAME BANK' }]) });
    await expect(provider(fake.fetch).accountName('Same Bank', ACCOUNT)).resolves.toBeNull();
  });

  it('says no such account on a refusal', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /institution/lookup': () => refused(422, 'could not resolve the account') });
    await expect(provider(fake.fetch).accountName('Guaranty Trust Bank', '0000000000')).resolves.toBeNull();
  });

  it('asks nothing about a number that is not ten digits', async () => {
    const fake = partner({});
    await expect(provider(fake.fetch).accountName('Guaranty Trust Bank', '123')).resolves.toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['a network failure', down],
    ['a 500', () => refused(500, 'oops')],
    ['a key refusal', () => refused(401, 'bad key')],
  ] as Array<[string, Route]>)('throws on %s, because that is not "no such account"', async (_, route) => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /institution/lookup': route });
    await expect(provider(fake.fetch).accountName('Guaranty Trust Bank', ACCOUNT)).rejects.toBeInstanceOf(SwitchError);
  });
});

describe('refusal', () => {
  const quote = () => ok({ rate: 1500.5, source: { amount: 20, currency: 'USDC' }, destination: { amount: 30010, currency: 'NGN' } });

  it('prices the USDC amount without creating anything', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/quote': quote });

    await expect(provider(fake.fetch).refusal(bank())).resolves.toBeNull();

    expect(fake.last('POST /offramp/quote').body).toEqual({
      amount: 20,
      country: 'NG',
      currency: 'NGN',
      asset: 'base:usdc',
      channel: 'BANK',
      exact_output: false,
    });
    expect(fake.count('POST /offramp/initiate')).toBe(0);
  });

  it('turns a minimum into plain words, not the partner sentence', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/quote': () => refused(400, 'Minimum amount per transaction is 1,365 NGN') });
    const reason = await provider(fake.fetch).refusal(bank());
    expect(reason).toContain('smallest amount');
    expect(reason).not.toContain('1,365');
  });

  it('refuses a quote for a different amount', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/quote': () => ok({ source: { amount: 19 } }) });
    await expect(provider(fake.fetch).refusal(bank())).resolves.toContain('unavailable');
  });

  it('calls an outage unavailable', async () => {
    const fake = partner({ 'GET /institution': down });
    await expect(provider(fake.fetch).refusal(bank())).resolves.toContain('unavailable');
  });

  it('refuses an unknown bank, and a bad request without asking', async () => {
    const fake = partner({ 'GET /institution': banksRoute });
    await expect(provider(fake.fetch).refusal(bank({ destination: { bankName: 'Nope', accountNumber: ACCOUNT, accountName: 'A' } }))).resolves.toContain('find that bank');
    const silent = partner({});
    await expect(provider(silent.fetch).refusal(bank({ usdcMinor: 0 }))).resolves.toContain('USDC');
    expect(silent.calls).toHaveLength(0);
  });
});

describe('fundingAddress and deposit', () => {
  it('creates the payment with the exact Switch contract and returns its address', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp()) });

    await expect(provider(fake.fetch, { callbackUrl: 'https://api.test/hook' }).fundingAddress(bank())).resolves.toBe(DEPOSIT);

    expect(fake.last('POST /offramp/initiate').body).toEqual({
      amount: 20,
      country: 'NG',
      currency: 'NGN',
      asset: 'base:usdc',
      channel: 'BANK',
      beneficiary: { account_number: ACCOUNT, bank_code: '058', holder_type: 'INDIVIDUAL', holder_name: 'CHINONSO ADEYEMI' },
      reference: 'ref-1',
      callback_url: 'https://api.test/hook',
      refund_address: REFUND,
      narration: 'CentralMonie payout to CHINONSO ADEYEMI',
      exact_output: false,
    });
  });

  it('gives the expiry and Switch naira figure in integers', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp()) });

    await expect(provider(fake.fetch).deposit(bank())).resolves.toEqual({
      address: DEPOSIT,
      expiresAt: '2026-11-03T10:30:00.000Z',
      usdcMinor: 20_000_000,
      destinationKobo: 3_001_000,
      rate: '1500.500000',
      providerStatus: 'AWAITING_DEPOSIT',
    });
  });

  it('leaves out a callback nobody set, and prefers the destination refund address', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp()) });
    const destination = { bankName: 'Guaranty Trust Bank', accountNumber: ACCOUNT, accountName: 'A', refundAddress: WALLET };

    await provider(fake.fetch).fundingAddress(bank({ destination }));

    const body = fake.last('POST /offramp/initiate').body as Record<string, unknown>;
    expect(body).not.toHaveProperty('callback_url');
    expect(body.refund_address).toBe(WALLET);
  });

  it('asks once for one reference, however it is called', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp()) });
    const payouts = provider(fake.fetch);

    const [first, second] = await Promise.all([payouts.fundingAddress(bank()), payouts.fundingAddress(bank())]);
    const third = await payouts.fundingAddress(bank());

    expect([second, third]).toEqual([first, first]);
    expect(fake.count('POST /offramp/initiate')).toBe(1);
  });

  it('asks again with the same reference after a network failure', async () => {
    let fail = true;
    const fake = partner({
      'GET /institution': banksRoute,
      'POST /offramp/initiate': () => {
        if (fail) return down();
        return ok(offramp());
      },
    });
    const payouts = provider(fake.fetch);

    await expect(payouts.fundingAddress(bank())).rejects.toThrow('unavailable');
    fail = false;
    await expect(payouts.fundingAddress(bank())).resolves.toBe(DEPOSIT);

    const references = fake.calls.filter((call) => call.key === 'POST /offramp/initiate').map((call) => (call.body as { reference: string }).reference);
    expect(references).toEqual(['ref-1', 'ref-1']);
  });

  it('hides a partner refusal behind plain words', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => refused(422, 'internal corridor note') });
    const failure = await provider(fake.fetch).fundingAddress(bank()).catch((err: Error) => err.message);
    expect(failure).toBe('We could not price that amount. Try a different amount.');
  });

  it.each([
    ['no address', { deposit: { amount: 20 } }],
    ['no deposit at all', { deposit: undefined }],
    ['an address that is not one', { deposit: { amount: 20, address: 'So11111111111111111111111111111111111111112' } }],
    ['a different source amount', { source: { amount: 19, currency: 'USDC' } }],
    ['a different deposit amount', { deposit: { amount: 21, address: DEPOSIT } }],
    ['an unreadable naira figure', { destination: { amount: '30010' } }],
    ['an unreadable rate', { rate: null }],
  ])('never hands over %s', async (_, overrides) => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp(overrides)) });
    await expect(provider(fake.fetch).fundingAddress(bank())).rejects.toThrow('unavailable');
  });

  it('refuses an unknown bank before creating anything', async () => {
    const fake = partner({ 'GET /institution': banksRoute });
    await expect(provider(fake.fetch).fundingAddress(bank({ destination: { bankName: 'No Such Bank', accountNumber: ACCOUNT, accountName: 'A' } }))).rejects.toThrow('find that bank');
    expect(fake.count('POST /offramp/initiate')).toBe(0);
  });

  it('never logs the account number or the key', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => refused(422, `bad account ${ACCOUNT}`) });

    await provider(fake.fetch).fundingAddress(bank()).catch(() => undefined);

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('[number]');
    expect(logged).not.toContain(ACCOUNT);
    expect(logged).not.toContain(KEY);
  });
});

describe('what the real sandbox answered on 3 November 2026', () => {
  const PLACEHOLDER = '0x000000000000000000000000000000000sandbox';
  const answer = () => ok(offramp({ deposit: { amount: 20, address: PLACEHOLDER } }));

  it('in the sandbox, takes the placeholder as no address, so USDC goes to the collection address', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': answer });
    await expect(provider(fake.fetch, { sandbox: true }).fundingAddress(bank())).resolves.toBeNull();
  });

  it('with a live key, refuses the placeholder, so nothing is ever sent to it', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': answer });
    await expect(provider(fake.fetch).fundingAddress(bank())).rejects.toThrow(/unavailable/);
  });

  it('on test money, refuses a real address, because that means the key is a live one', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => ok(offramp()) });
    await expect(provider(fake.fetch, { sandbox: true }).fundingAddress(bank())).rejects.toThrow(/unavailable/);
  });

  it('says a refused name needs saving again, not that the amount is too small', async () => {
    const message = 'Name can only contain alphanumeric characters, must contain at least one letter, should not contain crypto related terms.';
    const fake = partner({ 'GET /institution': banksRoute, 'POST /offramp/initiate': () => refused(400, message) });
    await expect(provider(fake.fetch).fundingAddress(bank())).rejects.toThrow(/saved again/);
  });

  it('understands the bank names people use', async () => {
    const fake = partner({ 'GET /institution': banksRoute, 'POST /institution/lookup': () => ok({ account_name: 'ADA BELLO' }) });
    await expect(provider(fake.fetch).accountName('GTBank', ACCOUNT)).resolves.toBe('ADA BELLO');
    expect(fake.last('POST /institution/lookup').body).toMatchObject({ beneficiary: { bank_code: '058' } });
  });
});

describe('pay', () => {
  const statusIs = (status: string): Route => () => ok(offramp({ status }));

  it('only reads status: it can never start or repeat a payment', async () => {
    const fake = partner({ 'GET /payment/status': statusIs('COMPLETED') });
    const payouts = provider(fake.fetch);

    const first = await payouts.pay(bank());
    const second = await payouts.pay(bank());

    expect(first).toEqual({ ok: true, providerReference: 'ref-1' });
    expect(second).toEqual(first);
    expect(fake.calls.every((call) => call.key === 'GET /payment/status')).toBe(true);
    expect(fake.calls[0]!.url).toBe(`${BASE}/payment/status?reference=ref-1`);
  });

  it.each(['AWAITING_DEPOSIT', 'PROCESSING', 'SCHEDULED', 'SOMETHING_NEW'])('is pending on %s', async (status) => {
    const fake = partner({ 'GET /payment/status': statusIs(status) });
    await expect(provider(fake.fetch).pay(bank())).resolves.toEqual({ ok: true, providerReference: 'ref-1', pending: true });
  });

  it.each(['FAILED', 'REVERSED', 'BLOCKED'])('has failed on %s', async (status) => {
    const fake = partner({ 'GET /payment/status': statusIs(status) });
    await expect(provider(fake.fetch).pay(bank())).resolves.toMatchObject({ ok: false });
  });

  it('is pending on a network failure, because nothing is known', async () => {
    const fake = partner({ 'GET /payment/status': down });
    await expect(provider(fake.fetch).pay(bank())).resolves.toMatchObject({ ok: true, pending: true });
  });

  it('has failed, for a person to check, when Switch does not know the payment', async () => {
    const fake = partner({ 'GET /payment/status': () => refused(404, 'unknown payment') });
    const result = await provider(fake.fetch).pay(bank());
    expect(result).toEqual({ ok: false, reason: 'The partner has no record of this bank payment. Check it before refunding.' });
  });

  it.each([
    ['zero USDC', { usdcMinor: 0 }],
    ['a float of USDC', { usdcMinor: 1.5 }],
    ['negative USDC', { usdcMinor: -1 }],
    ['zero naira', { amountKobo: 0 }],
    ['a float of naira', { amountKobo: 100.5 }],
    ['NaN', { amountKobo: Number.NaN }],
    ['the wrong route', { route: 'airtime' as const }],
    ['no reference', { reference: '' }],
    ['a long reference', { reference: 'x'.repeat(65) }],
    ['a short account number', { destination: { bankName: 'B', accountNumber: '123', accountName: 'A' } }],
    ['no account name', { destination: { bankName: 'B', accountNumber: ACCOUNT, accountName: ' ' } }],
    ['no bank', { destination: { accountNumber: ACCOUNT, accountName: 'A' } }],
    ['a bad refund address', { destination: { bankName: 'B', accountNumber: ACCOUNT, accountName: 'A', refundAddress: 'nope' } }],
    ['no destination', { destination: null }],
  ] as Array<[string, Partial<PaymentRequest>]>)('refuses %s without asking', async (_, overrides) => {
    const fake = partner({});
    await expect(provider(fake.fetch).pay(bank(overrides))).resolves.toMatchObject({ ok: false });
    await expect(provider(fake.fetch).fundingAddress(bank(overrides))).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('status', () => {
  const says = (status: unknown): Route => () => ok(offramp({ status }));

  it.each([
    ['COMPLETED', { state: 'completed' }],
    ['PROCESSING', { state: 'pending' }],
    ['AWAITING_DEPOSIT', { state: 'pending' }],
    [undefined, { state: 'pending' }],
  ])('reads %s', async (word, state) => {
    const fake = partner({ 'GET /payment/status': says(word) });
    await expect(provider(fake.fetch).status('ref-1', 'ref-1')).resolves.toEqual(state);
  });

  it.each(['FAILED', 'REVERSED', 'BLOCKED'])('reads %s as failed', async (word) => {
    const fake = partner({ 'GET /payment/status': says(word) });
    await expect(provider(fake.fetch).status('ref-1', 'ref-1')).resolves.toMatchObject({ state: 'failed' });
  });

  it.each([
    ['a network failure', down],
    ['a 502', () => refused(502, 'bad gateway')],
    ['a 429', () => refused(429, 'slow down')],
    ['a key refusal', () => refused(401, 'bad key')],
    ['an unreadable body', () => new Response('<html>', { status: 200 })],
  ] as Array<[string, Route]>)('stays pending on %s', async (_, route) => {
    const fake = partner({ 'GET /payment/status': route });
    await expect(provider(fake.fetch).status('ref-1', 'ref-1')).resolves.toEqual({ state: 'pending' });
  });

  it('falls back to our reference, and escapes it', async () => {
    const fake = partner({ 'GET /payment/status': says('COMPLETED') });
    await provider(fake.fetch).status('ref 1', '');
    expect(fake.calls[0]!.url).toBe(`${BASE}/payment/status?reference=ref+1`);
  });
});

describe('nairaOnramp', () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    status: 'AWAITING_DEPOSIT',
    type: 'ONRAMP',
    reference: 'order-1',
    rate: 1520.75,
    source: { amount: 50000, currency: 'NGN' },
    destination: { amount: 32.878514, currency: 'USDC', network: 'BASE' },
    deposit: {
      amount: 50000,
      account_number: '6022671694',
      account_name: 'Switchlabsltd Checkout',
      bank_name: 'Safehaven Microfinance Bank',
      expires_at: '2026-11-03T10:30:00.000Z',
    },
    ...overrides,
  });
  const input = { reference: 'order-1', amountKobo: 5_000_000, walletAddress: WALLET };

  it('sends the generic holder name and returns the instructions', async () => {
    const fake = partner({ 'POST /onramp/initiate': () => ok(order()) });

    await expect(provider(fake.fetch).nairaOnramp(input)).resolves.toEqual({
      reference: 'order-1',
      providerStatus: 'AWAITING_DEPOSIT',
      amountKobo: 5_000_000,
      usdcMinor: 32_878_514,
      rate: '1520.750000',
      bankName: 'Safehaven Microfinance Bank',
      bankCode: null,
      accountNumber: '6022671694',
      accountName: 'Switchlabsltd Checkout',
      expiresAt: '2026-11-03T10:30:00.000Z',
      note: [],
    });
    expect(fake.calls[0]!.body).toEqual({
      amount: 50000,
      country: 'NG',
      currency: 'NGN',
      asset: 'base:usdc',
      channel: 'BANK',
      beneficiary: { holder_type: 'INDIVIDUAL', holder_name: GENERIC_HOLDER_NAME, wallet_address: WALLET },
      reference: 'order-1',
      exact_output: false,
    });
  });

  it('uses its own callback URL', async () => {
    const fake = partner({ 'POST /onramp/initiate': () => ok(order()) });
    await provider(fake.fetch, { onrampCallbackUrl: 'https://api.test/on' }).nairaOnramp(input);
    expect((fake.calls[0]!.body as Record<string, unknown>).callback_url).toBe('https://api.test/on');
  });

  it('sends the same reference on a repeat, so Switch can return the original order', async () => {
    const fake = partner({ 'POST /onramp/initiate': () => ok(order()) });
    const ramp = provider(fake.fetch);
    await ramp.nairaOnramp(input);
    await ramp.nairaOnramp(input);
    expect(fake.calls.map((call) => (call.body as { reference: string }).reference)).toEqual(['order-1', 'order-1']);
  });

  it.each([
    ['no account to pay into', { deposit: { amount: 50000 } }],
    ['a price for another amount', { source: { amount: 49000, currency: 'NGN' } }],
    ['an unreadable USDC figure', { destination: { amount: 'lots' } }],
  ])('refuses %s', async (_, overrides) => {
    const fake = partner({ 'POST /onramp/initiate': () => ok(order(overrides)) });
    await expect(provider(fake.fetch).nairaOnramp(input)).rejects.toThrow('unavailable');
  });

  it('turns a minimum into plain words, and an outage into unavailable', async () => {
    const low = partner({ 'POST /onramp/initiate': () => refused(400, 'Minimum amount is 1,365 NGN') });
    await expect(provider(low.fetch).nairaOnramp(input)).rejects.toThrow('smallest amount');
    const out = partner({ 'POST /onramp/initiate': down });
    await expect(provider(out.fetch).nairaOnramp(input)).rejects.toThrow('unavailable');
  });

  it.each([
    ['zero', { amountKobo: 0 }],
    ['a float', { amountKobo: 100.5 }],
    ['negative', { amountKobo: -1 }],
    ['no reference', { reference: '' }],
    ['a bad wallet', { walletAddress: 'nope' }],
  ])('refuses %s without asking', async (_, overrides) => {
    const fake = partner({});
    await expect(provider(fake.fetch).nairaOnramp({ ...input, ...overrides })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('switchBeneficiaryName', () => {
  it('cleans a name into what Switch accepts', () => {
    expect(switchBeneficiaryName('Sani, Danjuma Halima')).toBe('Sani Danjuma Halima');
    expect(switchBeneficiaryName('Adéyẹmí Ọláwálé')).toBe('Adeyemi Olawale');
    expect(switchBeneficiaryName('  John    Paul  ')).toBe('John Paul');
  });

  it('falls back to the generic name', () => {
    expect(GENERIC_HOLDER_NAME).toMatch(/^[a-zA-Z0-9 ]+$/);
    expect(switchBeneficiaryName('')).toBe(GENERIC_HOLDER_NAME);
    expect(switchBeneficiaryName(null)).toBe(GENERIC_HOLDER_NAME);
    expect(switchBeneficiaryName('12345')).toBe(GENERIC_HOLDER_NAME);
  });
});

describe('webhooks', () => {
  const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts the raw body signed with the secret', () => {
    expect(verifySwitchWebhook('{"a":1}', sign('{"a":1}', 's'), 's')).toBe(true);
  });

  it('refuses a changed body, another secret, a missing or odd-length signature, and no secret', () => {
    expect(verifySwitchWebhook('{"a": 1}', sign('{"a":1}', 's'), 's')).toBe(false);
    expect(verifySwitchWebhook('{}', sign('{}', 'other'), 's')).toBe(false);
    expect(verifySwitchWebhook('{}', undefined, 's')).toBe(false);
    expect(verifySwitchWebhook('{}', 'short', 's')).toBe(false);
    expect(verifySwitchWebhook('{}', sign('{}', ''), '')).toBe(false);
  });

  it('bounds the timestamp, in seconds, milliseconds or a date', () => {
    const now = 1_800_000_000_000;
    expect(withinSwitchReplayWindow(String(now / 1000), now)).toBe(true);
    expect(withinSwitchReplayWindow(String(now), now)).toBe(true);
    expect(withinSwitchReplayWindow(new Date(now).toISOString(), now)).toBe(true);
    expect(withinSwitchReplayWindow(String(now / 1000 - 301), now)).toBe(false);
    expect(withinSwitchReplayWindow(String(now / 1000 + 301), now)).toBe(false);
    expect(withinSwitchReplayWindow('not a time', now)).toBe(true);
  });
});
