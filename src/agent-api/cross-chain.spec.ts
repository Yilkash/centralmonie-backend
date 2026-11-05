import { OneClickCrossChain, PAY_FROM, SimulatedCrossChain } from './cross-chain';

const request = { payFrom: 'near' as const, usdcMinor: 1_050_000, recipient: '0xrecipient', refundTo: 'agent.near', deadline: new Date('2026-11-05T00:00:00Z') };
const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const client = (fetchFn: jest.Mock, key?: string) => new OneClickCrossChain(key, 'https://oneclick.test', fetchFn as unknown as typeof fetch, 0);
const goodQuote = { quote: { depositAddress: '0xdeposit', amountIn: '1052400' } };

describe('OneClickCrossChain', () => {
  it('asks for an exact amount at the destination and returns the deposit details', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, goodQuote));
    await expect(client(fetchFn, 'secret').quote(request)).resolves.toEqual({ depositAddress: '0xdeposit', payInMinor: 1_052_400 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://oneclick.test/v0/quote');
    expect(init.headers.authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ dry: false, swapType: 'EXACT_OUTPUT', amount: '1050000', originAsset: PAY_FROM.near, destinationAsset: PAY_FROM.base, recipient: '0xrecipient', refundTo: 'agent.near', refundType: 'ORIGIN_CHAIN' });
  });

  it('marks a price check as dry, and sends no key when there is none', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { quote: { amountIn: '1052400' } }));
    await expect(client(fetchFn).priceCheck(request)).resolves.toEqual({ depositAddress: null, payInMinor: 1_052_400 });
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body).dry).toBe(true);
    expect(init.headers.authorization).toBeUndefined();
  });

  it('retries server faults and dropped connections, including a server fault reported as a 400', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(reply(400, { message: 'Internal server error' }))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(reply(502, 'bad gateway'))
      .mockResolvedValueOnce(reply(200, goodQuote));
    await expect(client(fetchFn).quote(request)).resolves.toMatchObject({ depositAddress: '0xdeposit' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('does not retry a plain refusal, and gives up after four tries', async () => {
    const refused = jest.fn().mockResolvedValue(reply(400, { message: 'amount is too low' }));
    await expect(client(refused).quote(request)).rejects.toThrow('amount is too low');
    expect(refused).toHaveBeenCalledTimes(1);
    const down = jest.fn().mockRejectedValue(new Error('down'));
    await expect(client(down).quote(request)).rejects.toThrow('down');
    expect(down).toHaveBeenCalledTimes(4);
  });

  it('refuses a quote it cannot use: no address, or less paid in than comes out', async () => {
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { amountIn: '1052400' } }))).quote(request)).rejects.toThrow('no deposit address');
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xd', amountIn: '5' } }))).quote(request)).rejects.toThrow('unusable');
  });

  it('refuses a quote that would deliver less than the partner needs', async () => {
    const short = jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xd', amountIn: '1052400', amountOut: '1049999' } }));
    await expect(client(short).quote(request)).rejects.toThrow('too little');
  });

  it.each([
    ['PENDING_DEPOSIT', 'waiting'],
    ['KNOWN_DEPOSIT_TX', 'moving'],
    ['PROCESSING', 'moving'],
    ['SUCCESS', 'delivered'],
    ['INCOMPLETE_DEPOSIT', 'underpaid'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed'],
  ])('reads %s as %s', async (word, status) => {
    await expect(client(jest.fn().mockResolvedValue(reply(200, { status: word }))).status('0xd')).resolves.toMatchObject({ status });
  });

  it('collects the transactions, and fails on a status it does not know', async () => {
    const swapDetails = { originChainTxHashes: [{ hash: '0xa' }], nearTxHashes: ['b'], destinationChainTxHashes: [{ hash: '0xc' }] };
    await expect(client(jest.fn().mockResolvedValue(reply(200, { status: 'SUCCESS', swapDetails }))).status('0xd')).resolves.toEqual({ status: 'delivered', transactions: ['0xa', 'b', '0xc'] });
    await expect(client(jest.fn().mockResolvedValue(reply(200, { status: 'NEW' }))).status('0xd')).rejects.toThrow('Unknown');
  });
});

describe('SimulatedCrossChain', () => {
  it('waits for one check, then delivers', async () => {
    const chain = new SimulatedCrossChain();
    const { depositAddress } = await chain.quote(request);
    await expect(chain.status(depositAddress!)).resolves.toMatchObject({ status: 'waiting' });
    await expect(chain.status(depositAddress!)).resolves.toMatchObject({ status: 'delivered' });
  });
});
