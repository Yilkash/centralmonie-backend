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

describe('checking a NEAR account exists', () => {
  const answering = (body: unknown) => jest.fn().mockResolvedValue({ json: async () => body }) as unknown as typeof fetch;
  const chain = (fetchFn: typeof fetch) => new OneClickCrossChain(undefined, 'https://1click.test', fetchFn, 0);

  it('is missing only when NEAR says so', async () => {
    await expect(chain(answering({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } })).nearAccountMissing('typo.near')).resolves.toBe(true);
    await expect(chain(answering({ result: { amount: '0' } })).nearAccountMissing('real.near')).resolves.toBe(false);
  });

  it('does not stop a payment when the check itself fails', async () => {
    await expect(chain(answering({ error: { cause: { name: 'UNAVAILABLE_SHARD' } } })).nearAccountMissing('real.near')).resolves.toBe(false);
    await expect(chain(jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch).nearAccountMissing('real.near')).resolves.toBe(false);
  });

  it('never asks about a 64-character account, which can receive before its first use', async () => {
    const fetchFn = answering({});
    await expect(chain(fetchFn).nearAccountMissing('a'.repeat(64))).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('sending to networks whose tokens use other decimals', () => {
  const send = (destinationDecimals: number) => ({ usdcMinor: 500_000, destinationAsset: 'asset', destinationDecimals, recipient: 'someone', refundTo: '0xwallet', deadline: new Date('2026-11-06T00:00:00Z'), dry: true });

  it('reads 0.5 USDC on Stellar (seven decimals) and on BNB Chain (eighteen) as 0.5 USDC', async () => {
    const stellar = jest.fn().mockResolvedValue(reply(200, { quote: { amountOut: '4798000', timeEstimate: 50 } }));
    await expect(client(stellar).sendFromBase(send(7))).resolves.toMatchObject({ receiverMinor: 479_800 });
    const bnb = jest.fn().mockResolvedValue(reply(200, { quote: { amountOut: '479812345678901234', timeEstimate: 20 } }));
    await expect(client(bnb).sendFromBase(send(18))).resolves.toMatchObject({ receiverMinor: 479_812 });
    // Read as six decimals, the Stellar figure would look like more than was sent, and is refused.
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { amountOut: '4798000' } }))).sendFromBase(send(6))).rejects.toThrow('unusable');
  });

  it('reads what arrived from the formatted figure, which is the same at any decimals', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { status: 'SUCCESS', swapDetails: { amountOut: '4798000', amountOutFormatted: '0.4798', destinationChainTxHashes: [{ hash: 'abc' }] } }));
    await expect(client(fetchFn).status('0xdeposit')).resolves.toMatchObject({ status: 'delivered', receivedMinor: 479_800 });
  });
});

describe('a Stellar receiver must be ready for USDC', () => {
  const horizon = (status: number, body: unknown) => jest.fn().mockResolvedValue(reply(status, body));
  const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const ADDRESS = 'GAZ6GHSFCKVVCOECNRJ7XKKP3KPSJ24ZGHJNLF3MPMOYOG2RXFU2Z6OB';

  it('is fine with an account that holds Circle USDC', async () => {
    const fetchFn = horizon(200, { balances: [{ asset_type: 'native', balance: '5' }, { asset_code: 'USDC', asset_issuer: ISSUER, balance: '0' }] });
    await expect(client(fetchFn).recipientProblem('stellar', ADDRESS)).resolves.toBeNull();
    expect(fetchFn.mock.calls[0][0]).toBe(`https://horizon.stellar.org/accounts/${ADDRESS}`);
  });

  it('stops an account with no USDC trustline, one holding a look-alike USDC, and one never opened', async () => {
    await expect(client(horizon(200, { balances: [{ asset_type: 'native', balance: '5' }] })).recipientProblem('stellar', ADDRESS)).resolves.toContain('has not added USDC');
    await expect(client(horizon(200, { balances: [{ asset_code: 'USDC', asset_issuer: 'GFAKEISSUER' }] })).recipientProblem('stellar', ADDRESS)).resolves.toContain('has not added USDC');
    await expect(client(horizon(404, { title: 'Resource Missing' })).recipientProblem('stellar', ADDRESS)).resolves.toContain('not been opened');
  });

  it('lets the route decide when Stellar cannot be reached, and never asks for other networks', async () => {
    await expect(client(jest.fn().mockRejectedValue(new Error('down'))).recipientProblem('stellar', ADDRESS)).resolves.toBeNull();
    const unused = jest.fn();
    await expect(client(unused).recipientProblem('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).resolves.toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });
});

describe('what a payer must send, on a network with eighteen decimals', () => {
  it('rounds up into six decimals, so sending the figure shown is never too little', async () => {
    const bnb = jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xd', amountIn: '1052400000000000001' } }));
    await expect(client(bnb).quote({ ...request, payFrom: 'bsc' })).resolves.toEqual({ depositAddress: '0xd', payInMinor: 1_052_401 });
    const even = jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xd', amountIn: '1052400000000000000' } }));
    await expect(client(even).quote({ ...request, payFrom: 'bsc' })).resolves.toEqual({ depositAddress: '0xd', payInMinor: 1_052_400 });
  });

  it('pays from Tron in USDT, the only token there', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, goodQuote));
    await client(fetchFn).quote({ ...request, payFrom: 'tron', payToken: 'USDT' });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).originAsset).toBe(PAY_FROM.tron);
  });
});

describe('deposits from another network into a Base wallet', () => {
  const deposit = { payFrom: 'bsc' as const, payToken: 'USDT' as const, amountMinor: 10_000_000, recipient: '0xwallet', refundTo: '0xmine', deadline: new Date('2026-11-06T12:00:00Z') };

  it('asks for an exact input in the network\'s own decimals, delivering USDC on Base to the wallet', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { quote: { depositAddress: '0xdep', amountOut: '9880000', timeEstimate: 60 } }));
    await expect(client(fetchFn).depositToBase(deposit)).resolves.toEqual({ depositAddress: '0xdep', receiverMinor: 9_880_000, seconds: 60 });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({
      dry: false, swapType: 'EXACT_INPUT', originAsset: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g', destinationAsset: PAY_FROM.base,
      amount: '10000000000000000000', recipient: '0xwallet', refundTo: '0xmine', refundType: 'ORIGIN_CHAIN',
    });
  });

  it('refuses a quote with no address', async () => {
    await expect(client(jest.fn().mockResolvedValue(reply(200, { quote: { amountOut: '1' } }))).depositToBase(deposit)).rejects.toThrow('unusable');
  });
});
