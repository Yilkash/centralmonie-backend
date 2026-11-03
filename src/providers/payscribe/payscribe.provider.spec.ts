import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentRequest } from '../providers';
import { isInsufficientProviderBalance, PayscribeError, PayscribeProvider, verifyPayscribeWebhook } from './payscribe.provider';

// Bodies follow Tokkenly's payscribe.client.spec.ts and fixtures.ts, which are Payscribe's own
// Postman examples. A requery that finds nothing has no example there: it is the generic refusal.
const REFUSED_LOOKUP = { status: false, description: 'Lookup validation failed. Please check back.', status_code: 400 };
const BASE = 'https://sandbox.payscribe.ng/api/v1';

type Route = () => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const vendBody = (details: Record<string, unknown>, status_code = 200) => ({
  status: true,
  description: 'Order received. Transaction in progress.',
  message: { details },
  status_code,
});
const requeryBody = (status: string) => ({
  status: true,
  description: 'Transaction found',
  message: { details: { trans_id: 'provider-1', status } },
  status_code: 200,
});
const notFound: Route = () => json(400, REFUSED_LOOKUP);
const processing: Route = () => json(200, vendBody({ transaction_status: 'processing', trans_id: 'tx-1' }));

/** A partner answering by "METHOD /path". An unlisted call fails the test rather than reading as a network error. */
function partner(routes: Record<string, Route>) {
  const calls: Array<{ key: string; url: string; init: RequestInit }> = [];
  const fake = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method} ${url.pathname.replace('/api/v1', '')}`;
    calls.push({ key, url: String(input), init: init ?? {} });
    const route = routes[key];
    if (!route) throw new Error(`unexpected call: ${key}`);
    return route();
  });
  return { fetch: fake as unknown as typeof fetch, calls, count: (key: string) => calls.filter((call) => call.key === key).length };
}

const provider = (fake: typeof fetch, now?: () => number) =>
  new PayscribeProvider({ baseUrl: `${BASE}/`, apiKey: 'sk_test_example', fetch: fake, ...(now ? { now } : {}) });

const airtime = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  reference: 'ref-1',
  route: 'airtime',
  destination: { phone: '08031234567', network: 'MTN' },
  amountKobo: 50_000,
  usdcMinor: 333_333,
  ...overrides,
});
const data = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  ...airtime(),
  route: 'data',
  destination: { phone: '08031234567', network: 'MTN', dataPlanId: 'PSPLAN_185' },
  amountKobo: 14_775,
  ...overrides,
});

const MTN_PLANS = {
  status: true,
  description: 'MTN data plan lookup successfully.',
  message: {
    details: [
      {
        network_name: 'mtn',
        title: 'MTN Data',
        plans: [
          { plan_code: 'PSPLAN_185', name: '500MB - 30days val - GIFTING', category: 'gifting', alias: '500MB_GIFTING', amount: 147.75 },
          { category: 'Awoof', plans: [{ plan_code: 'PSPLAN_5367', name: 'MTN 110MB -1DAYS-awoof', amount: 101 }, { name: 'incomplete provider row' }] },
          { category: 'Data share', plans: [{ plan_code: 'PSPLAN_5356', name: 'MTN 500MB -30DAYS -data share', amount: '315.00' }] },
          { plan_code: 'PSPLAN_BAD', name: 'bad price', amount: 'free' },
        ],
      },
    ],
  },
  status_code: 200,
};
const emptyPlans = { status: true, message: { details: [] }, status_code: 200 };
const balances = (naira: unknown) => ({
  status: true,
  description: 'Account balance fetched successfully.',
  message: {
    details: [
      { currency: 'USD', available_balance: 1 },
      { currency: 'NGN', available_balance: naira },
    ],
  },
  status_code: 200,
});

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe('construction', () => {
  it('refuses to run without a key or URL', () => {
    expect(() => new PayscribeProvider({ baseUrl: BASE, apiKey: '' })).toThrow('apiKey');
    expect(() => new PayscribeProvider({ baseUrl: '', apiKey: 'k' })).toThrow('baseUrl');
  });
});

describe('data plans', () => {
  it('reads the plan list into integer kobo, flattening groups and hiding awoof', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(200, MTN_PLANS) });

    const plans = await provider(fake.fetch).forNetwork('MTN');

    expect(fake.calls[0]!.url).toBe(`${BASE}/data/lookup?network=mtn`);
    expect(plans).toEqual([
      { id: 'PSPLAN_185', network: 'MTN', label: '500MB - 30days val - GIFTING', priceKobo: 14_775 },
      { id: 'PSPLAN_5356', network: 'MTN', label: 'MTN 500MB -30DAYS -data share', priceKobo: 31_500 },
    ]);
  });

  it('caches a list for a few minutes, then asks again', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(200, MTN_PLANS) });
    let now = 1_000;
    const payscribe = provider(fake.fetch, () => now);

    await payscribe.forNetwork('mtn');
    await payscribe.forNetwork('MTN');
    expect(fake.calls).toHaveLength(1);

    now += 5 * 60_000 + 1;
    await payscribe.forNetwork('mtn');
    expect(fake.calls).toHaveLength(2);
  });

  it('has nothing for an unknown network, without asking', async () => {
    const fake = partner({});
    await expect(provider(fake.fetch).forNetwork('smile')).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('finds a plan by id across networks, even if another list failed', async () => {
    const fake = partner({
      'GET /data/lookup': () => {
        const network = new URL(fake.calls[fake.calls.length - 1]!.url).searchParams.get('network');
        return network === 'mtn' ? json(200, MTN_PLANS) : json(503, { status: false, description: 'down' });
      },
    });
    await expect(provider(fake.fetch).find('PSPLAN_185')).resolves.toMatchObject({ id: 'PSPLAN_185', network: 'MTN' });
  });

  it('will not say a plan is gone while a list could not be read', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(503, { status: false, description: 'down' }) });
    await expect(provider(fake.fetch).find('PSPLAN_185')).rejects.toBeInstanceOf(PayscribeError);
  });

  it('answers null when every list was read and the plan is in none', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(200, emptyPlans) });
    await expect(provider(fake.fetch).find('nope')).resolves.toBeNull();
  });
});

describe('refusal', () => {
  it('takes on airtime the balance covers, sending the bearer key', async () => {
    const fake = partner({ 'GET /my-account/balances': () => json(200, balances(40149.3499999999985448084771633148193359375)) });

    await expect(provider(fake.fetch).refusal(airtime())).resolves.toBeNull();
    expect((fake.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_example');
  });

  it('refuses when the balance is short, without stating the balance', async () => {
    const fake = partner({ 'GET /my-account/balances': () => json(200, balances(499.99)) });
    const reason = await provider(fake.fetch).refusal(airtime());
    expect(reason).toContain('temporarily unavailable');
    expect(reason).not.toContain('499');
  });

  it('accepts a balance of exactly the amount', async () => {
    const fake = partner({ 'GET /my-account/balances': () => json(200, balances('500.00')) });
    await expect(provider(fake.fetch).refusal(airtime())).resolves.toBeNull();
  });

  it.each([
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
    ['a refusal', () => json(401, { status: false, description: 'bad key' })],
    ['no naira row', () => json(200, { status: true, message: { details: [{ currency: 'USD', available_balance: 1 }] } })],
    ['a nonsense figure', () => json(200, balances('lots'))],
  ] as Array<[string, Route]>)('refuses on %s, rather than charging blind', async (_, route) => {
    const fake = partner({ 'GET /my-account/balances': route });
    await expect(provider(fake.fetch).refusal(airtime())).resolves.toContain('temporarily unavailable');
  });

  it('refuses a data plan that has gone or changed price', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(200, MTN_PLANS) });
    await expect(provider(fake.fetch).refusal(data({ destination: { phone: '08031234567', network: 'MTN', dataPlanId: 'gone' } }))).resolves.toContain('no longer');
    await expect(provider(fake.fetch).refusal(data({ amountKobo: 10_000 }))).resolves.toContain('price');
  });

  it('checks the balance for a data plan that is still right', async () => {
    const fake = partner({ 'GET /data/lookup': () => json(200, MTN_PLANS), 'GET /my-account/balances': () => json(200, balances(1000)) });
    await expect(provider(fake.fetch).refusal(data())).resolves.toBeNull();
  });

  it('refuses a bad request without asking anything', async () => {
    const fake = partner({});
    await expect(provider(fake.fetch).refusal(airtime({ route: 'bank' }))).resolves.toContain('only handles');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('fundingAddress', () => {
  it('uses the platform collection address', async () => {
    await expect(provider(partner({}).fetch).fundingAddress()).resolves.toBeNull();
  });
});

describe('pay', () => {
  it('sends the exact airtime contract, after checking the reference is unused', async () => {
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': processing });

    const result = await provider(fake.fetch).pay(airtime());

    expect(fake.calls.map((call) => call.key)).toEqual(['GET /requery', 'POST /airtime']);
    expect(fake.calls[0]!.url).toBe(`${BASE}/requery?trans_id=ref-1`);
    expect(JSON.parse(fake.calls[1]!.init.body as string)).toEqual({
      network: 'mtn',
      amount: 500,
      recipient: '08031234567',
      ported: false,
      ref: 'ref-1',
    });
    expect(result).toEqual({ ok: true, providerReference: 'tx-1', pending: true });
  });

  it('sends the exact data contract', async () => {
    const fake = partner({ 'GET /requery': notFound, 'POST /data/vend': processing });

    await provider(fake.fetch).pay(data());

    expect(JSON.parse(fake.calls[1]!.init.body as string)).toEqual({
      plan: 'PSPLAN_185',
      recipient: ['08031234567'],
      network: 'mtn',
      ref: 'ref-1',
    });
  });

  it('refuses data with no plan id, sending nothing', async () => {
    const fake = partner({});
    const result = await provider(fake.fetch).pay(data({ destination: { phone: '08031234567', network: 'MTN' } }));
    expect(result).toEqual({ ok: false, reason: 'A data payment needs a data plan.' });
    expect(fake.calls).toHaveLength(0);
  });

  it('completes only when Payscribe says it was delivered', async () => {
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(200, vendBody({ trans_id: 'tx-2', transaction_status: 'success' })) });
    await expect(provider(fake.fetch).pay(airtime())).resolves.toEqual({ ok: true, providerReference: 'tx-2' });
  });

  it('keeps a 201 pending', async () => {
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(201, vendBody({ trans_id: 'tx-3', status: 'pending' }, 201)) });
    await expect(provider(fake.fetch).pay(airtime())).resolves.toEqual({ ok: true, providerReference: 'tx-3', pending: true });
  });

  it.each([
    ['an empty answer', () => json(200, { status: true, status_code: 200 })],
    ['a word it does not know', () => json(200, vendBody({ trans_id: 'tx-4', status: 'queued-for-review' }))],
  ] as Array<[string, Route]>)('never reads %s as delivered', async (_, route) => {
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': route });
    await expect(provider(fake.fetch).pay(airtime())).resolves.toMatchObject({ ok: true, pending: true });
  });

  it.each(['failed', 'declined', 'reversed', 'unsuccessful'])('reads a vend that says %s as not delivered', async (word) => {
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(200, vendBody({ trans_id: 'tx-5', status: word })) });
    await expect(provider(fake.fetch).pay(airtime())).resolves.toMatchObject({ ok: false });
  });

  it('reports a partner refusal in its own words, never the balance', async () => {
    const sentence = 'Insufficient Funds. You need a total of 100.00 ngn to process this transaction. Your available + facility balance is 35.40';
    const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(400, { status: false, description: sentence, status_code: 400 }) });

    const result = await provider(fake.fetch).pay(airtime());

    expect(result).toEqual({ ok: false, reason: 'The airtime or data could not be delivered.' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ran short'));
  });

  it('recognises the short-balance sentence', () => {
    expect(isInsufficientProviderBalance(new PayscribeError('Insufficient Funds. You need', 400))).toBe(true);
    expect(isInsufficientProviderBalance(new PayscribeError('Bad number', 400))).toBe(false);
    expect(isInsufficientProviderBalance(new Error('Insufficient Funds'))).toBe(false);
  });

  it('never logs a phone number or the key', async () => {
    const fake = partner({
      'GET /requery': notFound,
      'POST /airtime': () => json(400, { status: false, description: 'Cannot vend to 08031234567', status_code: 400 }),
    });

    await provider(fake.fetch).pay(airtime());

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('[number]');
    expect(logged).not.toContain('08031234567');
    expect(logged).not.toContain('sk_test_example');
  });

  describe('when the answer to a vend is lost', () => {
    it.each([
      ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
      ['a 502', () => json(502, { status: false, description: 'bad gateway' })],
      ['a 429', () => json(429, { status: false, description: 'slow down' })],
      ['an unreadable body', () => new Response('<html>', { status: 200 })],
    ] as Array<[string, Route]>)('stays pending after %s, and never vends again', async (_, route) => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': route });
      const payscribe = provider(fake.fetch);

      const first = await payscribe.pay(airtime());
      const second = await payscribe.pay(airtime());

      expect(first).toEqual({ ok: true, providerReference: 'ref-1', pending: true });
      expect(second).toEqual(first);
      expect(fake.count('POST /airtime')).toBe(1);
    });
  });

  describe('when the first requery gets no usable answer', () => {
    it('throws having vended nothing, and a later call tries again', async () => {
      let down = true;
      const fake = partner({
        'GET /requery': () => (down ? Promise.reject(new TypeError('fetch failed')) : notFound()),
        'POST /airtime': processing,
      });
      const payscribe = provider(fake.fetch);

      await expect(payscribe.pay(airtime())).rejects.toThrow('temporarily unavailable');
      expect(fake.count('POST /airtime')).toBe(0);

      down = false;
      await expect(payscribe.pay(airtime())).resolves.toMatchObject({ ok: true, pending: true });
      expect(fake.count('POST /airtime')).toBe(1);
    });

    it('does not vend after a key refusal either', async () => {
      const fake = partner({ 'GET /requery': () => json(401, { status: false, description: 'bad key' }) });
      await expect(provider(fake.fetch).pay(airtime())).rejects.toThrow();
      expect(fake.count('POST /airtime')).toBe(0);
    });
  });

  describe('a repeat with the same reference', () => {
    it('does not vend again, one after another', async () => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(200, vendBody({ trans_id: 'tx-6', status: 'success' })) });
      const payscribe = provider(fake.fetch);

      const first = await payscribe.pay(airtime());
      await expect(payscribe.pay(airtime())).resolves.toEqual(first);

      expect(fake.count('POST /airtime')).toBe(1);
    });

    it('does not vend again when both arrive at once', async () => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': processing });
      const payscribe = provider(fake.fetch);

      const [first, second] = await Promise.all([payscribe.pay(airtime()), payscribe.pay(airtime())]);

      expect(second).toEqual(first);
      expect(fake.count('POST /airtime')).toBe(1);
    });

    it('repeats a refusal rather than vending again', async () => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': () => json(400, { status: false, description: 'no' }) });
      const payscribe = provider(fake.fetch);

      await payscribe.pay(airtime());
      await expect(payscribe.pay(airtime())).resolves.toMatchObject({ ok: false });

      expect(fake.count('POST /airtime')).toBe(1);
    });

    it('finds the first purchase after a restart, through requery', async () => {
      const fake = partner({ 'GET /requery': () => json(200, requeryBody('success')) });

      await expect(provider(fake.fetch).pay(airtime())).resolves.toEqual({ ok: true, providerReference: 'provider-1' });

      expect(fake.count('POST /airtime')).toBe(0);
    });

    it('reports a failed first purchase after a restart, without vending', async () => {
      const fake = partner({ 'GET /requery': () => json(200, requeryBody('reversed')) });
      await expect(provider(fake.fetch).pay(airtime())).resolves.toMatchObject({ ok: false });
      expect(fake.count('POST /airtime')).toBe(0);
    });

    it('vends when the requery answers true but describes no transaction', async () => {
      const fake = partner({ 'GET /requery': () => json(200, { status: true, status_code: 200 }), 'POST /airtime': processing });
      await expect(provider(fake.fetch).pay(airtime())).resolves.toMatchObject({ pending: true });
      expect(fake.count('POST /airtime')).toBe(1);
    });

    it('treats different references as different payments', async () => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': processing });
      const payscribe = provider(fake.fetch);

      await payscribe.pay(airtime());
      await payscribe.pay(airtime({ reference: 'ref-2' }));

      expect(fake.count('POST /airtime')).toBe(2);
    });
  });

  describe('bad requests, which never reach the partner', () => {
    it.each([
      ['zero', { amountKobo: 0 }],
      ['negative', { amountKobo: -50_000 }],
      ['a float', { amountKobo: 50_000.5 }],
      ['NaN', { amountKobo: Number.NaN }],
      ['unsafely large', { amountKobo: Number.MAX_SAFE_INTEGER + 1 }],
      ['part of a naira', { amountKobo: 50_050 }],
      ['below N50', { amountKobo: 4_900 }],
      ['above N20,000', { amountKobo: 2_000_100 }],
      ['a float of USDC', { usdcMinor: 1.5 }],
      ['no USDC', { usdcMinor: 0 }],
      ['the wrong route', { route: 'bank' as const }],
      ['no reference', { reference: '' }],
      ['a long reference', { reference: 'x'.repeat(65) }],
      ['a bad phone', { destination: { phone: '12345', network: 'MTN' } }],
      ['an unknown network', { destination: { phone: '08031234567', network: 'Smile' } }],
      ['no destination', { destination: null }],
    ] as Array<[string, Partial<PaymentRequest>]>)('refuses %s', async (_, overrides) => {
      const fake = partner({});
      await expect(provider(fake.fetch).pay(airtime(overrides))).resolves.toMatchObject({ ok: false });
      expect(fake.calls).toHaveLength(0);
    });

    it.each([[5_000], [2_000_000]])('accepts the airtime limit of %s kobo', async (amountKobo) => {
      const fake = partner({ 'GET /requery': notFound, 'POST /airtime': processing });
      await expect(provider(fake.fetch).pay(airtime({ amountKobo }))).resolves.toMatchObject({ ok: true });
    });
  });
});

describe('status', () => {
  it.each([
    ['success', { state: 'completed' }],
    ['Successful', { state: 'completed' }],
    ['processing', { state: 'pending' }],
    ['queued-for-review', { state: 'pending' }],
    ['reversed', { state: 'failed', reason: 'The airtime or data could not be delivered.' }],
  ])('reads %s', async (word, state) => {
    const fake = partner({ 'GET /requery': () => json(200, requeryBody(word)) });
    await expect(provider(fake.fetch).status('ref-1', 'tx 1')).resolves.toEqual(state);
    expect(fake.calls[0]!.url).toBe(`${BASE}/requery?trans_id=tx%201`);
  });

  it('falls back to our reference when there is no provider one', async () => {
    const fake = partner({ 'GET /requery': () => json(200, requeryBody('success')) });
    await provider(fake.fetch).status('ref-1', '');
    expect(fake.calls[0]!.url).toBe(`${BASE}/requery?trans_id=ref-1`);
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 500', () => json(500, { status: false, description: 'oops' })],
    ['an unreadable body', () => new Response('nope', { status: 200 })],
    ['a key refusal', () => json(403, { status: false, description: 'forbidden' })],
    ['an answer with no transaction', () => json(200, { status: true, status_code: 200 })],
    ['a transaction with no status', () => json(200, vendBody({ trans_id: 'tx' }))],
  ] as Array<[string, Route]>)('stays pending on %s', async (_, route) => {
    const fake = partner({ 'GET /requery': route });
    await expect(provider(fake.fetch).status('ref-1', 'tx')).resolves.toEqual({ state: 'pending' });
  });

  it('stays pending on "no record" and flags it for a person, so no USDC is refunded on a guess', async () => {
    const fake = partner({ 'GET /requery': notFound });
    await expect(provider(fake.fetch).status('ref-1', 'ref-1')).resolves.toEqual({ state: 'pending' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('a person must check'));
  });
});

describe('verifyPayscribeWebhook', () => {
  const SECRET = 'sk_test_example';
  const NOW = 1_800_000_000_000;
  const timestamp = String(NOW / 1000);
  const sign = (body: string, eventId = 'evt-1', secret = SECRET, at = timestamp) =>
    `v1=${createHmac('sha256', secret).update(`${at}.${eventId}.${body}`).digest('hex')}`;
  const headers = (signature: string, at = timestamp) => ({ signature, timestamp: at, eventId: 'evt-1' });

  it('accepts a correctly signed body', () => {
    expect(verifyPayscribeWebhook('{"a":1}', headers(sign('{"a":1}')), SECRET, NOW)).toBe(true);
  });

  it('refuses another key, a changed body, or a moved event id', () => {
    expect(verifyPayscribeWebhook('{"a":1}', headers(sign('{"a":1}', 'evt-1', 'other')), SECRET, NOW)).toBe(false);
    expect(verifyPayscribeWebhook('{"a":2}', headers(sign('{"a":1}')), SECRET, NOW)).toBe(false);
    expect(verifyPayscribeWebhook('{"a":1}', headers(sign('{"a":1}', 'evt-2')), SECRET, NOW)).toBe(false);
  });

  it('refuses a replay after the window, and one from the future', () => {
    const body = '{}';
    const old = String(NOW / 1000 - 301);
    const ahead = String(NOW / 1000 + 301);
    expect(verifyPayscribeWebhook(body, headers(sign(body, 'evt-1', SECRET, old), old), SECRET, NOW)).toBe(false);
    expect(verifyPayscribeWebhook(body, headers(sign(body, 'evt-1', SECRET, ahead), ahead), SECRET, NOW)).toBe(false);
  });

  it('refuses a malformed header or no secret, without throwing', () => {
    expect(verifyPayscribeWebhook('{}', headers('v1=short'), SECRET, NOW)).toBe(false);
    expect(verifyPayscribeWebhook('{}', {}, SECRET, NOW)).toBe(false);
    expect(verifyPayscribeWebhook('{}', headers(sign('{}', 'evt-1', '')), '', NOW)).toBe(false);
  });
});
