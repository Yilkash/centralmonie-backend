import { OneClickCrossChain, PAY_FROM, routeProblem, SimulatedCrossChain } from './cross-chain';

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

  it('adds our fee when one is set, and sends none when it is off', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, goodQuote));
    await new OneClickCrossChain('k', 'https://oneclick.test', fetchFn as unknown as typeof fetch, 0, { bps: 50, recipient: '10kobo.near' }).quote(request);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).appFees).toEqual([{ recipient: '10kobo.near', fee: 50 }]);
    const none = jest.fn().mockResolvedValue(reply(200, goodQuote));
    await client(none).quote(request);
    expect(JSON.parse(none.mock.calls[0][1].body).appFees).toBeUndefined();
  });

  it('sends an exact amount from Base to the chosen chain, refunding the sender, and reports what arrives', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xdeposit', amountOut: '4989536', timeEstimate: 32 } }));
    const send = { usdcMinor: 5_000_000, destinationAsset: PAY_FROM.solana, recipient: 'someone', refundTo: '0xwallet', deadline: new Date('2026-11-05T00:00:00Z'), dry: false };
    await expect(client(fetchFn).sendFromBase(send)).resolves.toEqual({ depositAddress: '0xdeposit', receiverMinor: 4_989_536, seconds: 32 });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({ dry: false, swapType: 'EXACT_INPUT', originAsset: PAY_FROM.base, destinationAsset: PAY_FROM.solana, amount: '5000000', recipient: 'someone', refundTo: '0xwallet', refundType: 'ORIGIN_CHAIN' });
  });

  it('refuses a send quote it cannot use', async () => {
    const send = { usdcMinor: 5_000_000, destinationAsset: PAY_FROM.near, recipient: 'a.near', refundTo: '0xw', deadline: new Date(), dry: false };
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { amountOut: '4000000' } }))).sendFromBase(send)).rejects.toThrow('no deposit address');
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xd', amountOut: '6000000' } }))).sendFromBase(send)).rejects.toThrow('unusable');
  });

  it.each([
    ['Amount is too low for bridge', 'too small'],
    ['Destination address does not have a trustline for this asset', 'not set up'],
    ['Temporary swap limits: minimum swap amount is $1,000', 'limited'],
    ['Quoting for this pair is not available', 'not available'],
    ['secret partner detail', 'not available'],
  ])('turns "%s" into a sentence for the user', (message, expected) => {
    const sentence = routeProblem(new Error(message), 'Solana');
    expect(sentence).toContain(expected);
    expect(sentence).toContain('Nothing was sent');
    expect(sentence).not.toContain('partner');
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
    await expect(client(jest.fn().mockResolvedValue(reply(200, { status: 'SUCCESS', swapDetails: { ...swapDetails, amountOut: '494598' } }))).status('0xd')).resolves.toMatchObject({ receivedMinor: 494598 });
    await expect(client(jest.fn().mockResolvedValue(reply(200, { status: 'SUCCESS', swapDetails }))).status('0xd')).resolves.toEqual({ status: 'delivered', transactions: ['0xa', 'b', '0xc'], destinationTx: '0xc', receivedMinor: null });
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
