import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Guard, runAgent, usdcToMinor, type Block, type Model } from '../src/agent.ts';
import { ApiRefusal, type Payment, type PaymentApi, type QuoteRequest } from '../src/api.ts';
import { SimulatedWallet } from '../src/wallet.ts';

const quoted = (over: Partial<Payment> = {}): Payment => ({ id: 'q1', status: 'quoted', amount: '₦1,400.00', pay_usdc: '1.010000', account_name: 'Ada Bello', account_number: '****4568', bank_name: 'OPay', deposit_address: null, failure_reason: null, ...over });

class FakeApi implements PaymentApi {
  quotes: QuoteRequest[] = [];
  accepted: string[] = [];
  quoteAnswer = quoted();
  acceptAnswer = quoted({ status: 'awaiting_deposit', deposit_address: '0xdeposit' });
  finalAnswer = quoted({ status: 'paid', deposit_address: '0xdeposit' });
  async quote(request: QuoteRequest) {
    this.quotes.push(request);
    return this.quoteAnswer;
  }
  async accept(id: string) {
    this.accepted.push(id);
    return this.acceptAnswer;
  }
  async status() {
    return this.finalAnswer;
  }
}

const use = (name: string, input: unknown, id = name): Block => ({ type: 'tool_use', id, name, input });
const QUOTE = { amount_naira: 1400, bank_name: 'OPay', account_number: '8031234568' };
/** Plays back fixed answers, standing in for the AI, including one that has been tricked. */
const scripted = (...turns: Block[][]): Model => {
  let turn = 0;
  return async () => ({ content: turns[turn++] ?? [use('finish', { outcome: 'failed', reason: 'script ended' })] });
};

describe('the demo agent', () => {
  let api: FakeApi;
  let wallet: SimulatedWallet;
  const run = (model: Model, budgetUsdc = '2') => runAgent({ model, api, wallet, budgetUsdc, task: 'Pay it.', invoice: 'an invoice', pollMs: 1 });

  beforeEach(() => {
    api = new FakeApi();
    wallet = new SimulatedWallet();
  });

  it('quotes, pays the exact amount to the deposit address, and reports paid with the receipt data', async () => {
    const result = await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'paid', reason: 'done' })]));
    assert.equal(result.outcome, 'paid');
    assert.deepEqual(wallet.sent, [{ to: '0xdeposit', usdcMinor: 1_010_000 }]);
  });

  it('moves nothing when the agent decides not to pay', async () => {
    const result = await run(scripted([use('get_quote', QUOTE)], [use('finish', { outcome: 'refused', reason: 'name differs' })]));
    assert.equal(result.outcome, 'refused');
    assert.equal(wallet.sent.length, 0);
    assert.equal(api.accepted.length, 0);
  });

  it('refuses a payment over budget even when a tricked model asks for it, before accepting the quote', async () => {
    api.quoteAnswer = quoted({ pay_usdc: '360.000000' });
    const result = await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'paid', reason: 'all paid' })]));
    assert.equal(wallet.sent.length, 0);
    assert.equal(api.accepted.length, 0);
    assert.equal(result.outcome, 'failed', 'a model saying paid does not make it paid');
  });

  it('refuses when the price rises past the budget at the moment of accepting', async () => {
    api.acceptAnswer = quoted({ status: 'awaiting_deposit', deposit_address: '0xdeposit', pay_usdc: '2.500000' });
    await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'failed', reason: 'too dear' })]));
    assert.equal(wallet.sent.length, 0);
  });

  it('refuses a quote id it never received, so a made-up payment goes nowhere', async () => {
    await run(scripted([use('pay_quote', { quote_id: 'invented' })], [use('finish', { outcome: 'failed', reason: 'x' })]));
    assert.equal(api.accepted.length, 0);
    assert.equal(wallet.sent.length, 0);
  });

  it('never pays twice in one task', async () => {
    await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' }, 'a')], [use('pay_quote', { quote_id: 'q1' }, 'b')], [use('finish', { outcome: 'paid', reason: 'x' })]));
    assert.equal(wallet.sent.length, 1);
  });

  it('does not try again when a send fails, because it may have gone', async () => {
    wallet.sendUsdc = async () => {
      throw new Error('connection lost');
    };
    let answers = 0;
    const model: Model = async ({ messages }) => {
      answers++;
      if (answers === 1) return { content: [use('get_quote', QUOTE)] };
      if (answers <= 3) return { content: [use('pay_quote', { quote_id: 'q1' }, `p${answers}`)] };
      return { content: [use('finish', { outcome: 'failed', reason: JSON.stringify(messages.at(-1)) })] };
    };
    const result = await run(model);
    assert.equal(api.accepted.length, 1);
    assert.match(result.reason, /already sent one payment/);
    assert.equal(result.outcome, 'failed');
  });

  it('passes a refusal from the API to the model as a sentence, and moves nothing', async () => {
    api.quote = async () => {
      throw new ApiRefusal('account_not_found', 'We could not find that account.');
    };
    let seen = '';
    const model: Model = async ({ messages }) => {
      if (messages.length === 1) return { content: [use('get_quote', QUOTE)] };
      seen = JSON.stringify(messages.at(-1));
      return { content: [use('finish', { outcome: 'failed', reason: 'no account' })] };
    };
    await run(model);
    assert.match(seen, /account_not_found/);
    assert.equal(wallet.sent.length, 0);
  });

  it('reports failed if the money did not arrive, whatever the model claims', async () => {
    api.finalAnswer = quoted({ status: 'refunded', deposit_address: '0xdeposit' });
    const result = await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'paid', reason: 'great' })]));
    assert.equal(result.outcome, 'failed');
  });

  it('reports what is known when the model cannot be reached, and sends nothing further', async () => {
    const down: Model = async () => {
      throw new Error('connection error');
    };
    assert.equal((await run(down)).outcome, 'no_decision');
    assert.equal(wallet.sent.length, 0);
    let turn = 0;
    const dropsAfterPaying: Model = async () => {
      turn++;
      if (turn === 1) return { content: [use('get_quote', QUOTE)] };
      if (turn === 2) return { content: [use('pay_quote', { quote_id: 'q1' })] };
      throw new Error('connection error');
    };
    assert.equal((await run(dropsAfterPaying)).outcome, 'paid');
  });

  it('refuses any account the owner did not allow, even if the invoice names it', async () => {
    const result = await runAgent({ model: scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'failed', reason: 'x' })]), api, wallet, budgetUsdc: '2', allowedAccounts: ['8000000000'], task: 't', invoice: 'i', pollMs: 1 });
    assert.equal(api.quotes.length, 0);
    assert.equal(wallet.sent.length, 0);
    assert.equal(result.outcome, 'failed');
  });

  it('sends nothing when a payment is no longer waiting for money', async () => {
    api.acceptAnswer = quoted({ status: 'paid', deposit_address: null });
    await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'failed', reason: 'x' })]));
    assert.equal(wallet.sent.length, 0);
  });

  it('cannot report refused once money has been sent', async () => {
    api.finalAnswer = quoted({ status: 'refunded', deposit_address: '0xdeposit' });
    const result = await run(scripted([use('get_quote', QUOTE)], [use('pay_quote', { quote_id: 'q1' })], [use('finish', { outcome: 'refused', reason: 'x' })]));
    assert.equal(result.outcome, 'failed');
  });

  it('gives no decision if the model stops early, or runs out of steps', async () => {
    assert.equal((await run(scripted([{ type: 'text', text: 'hmm' }]))).outcome, 'no_decision');
    const looping: Model = async () => ({ content: [use('get_quote', QUOTE)] });
    assert.equal((await runAgent({ model: looping, api, wallet, budgetUsdc: '2', task: 't', invoice: 'i', maxTurns: 3 })).outcome, 'no_decision');
  });
});

describe('the budget guard', () => {
  it('reads USDC amounts exactly, and allows exactly the budget', () => {
    assert.equal(usdcToMinor('1.05'), 1_050_000);
    assert.throws(() => usdcToMinor('1e9'));
    const guard = new Guard('2');
    assert.equal(guard.overBudget('2.000000'), null);
    assert.match(guard.overBudget('2.000001') ?? '', /over the budget/);
  });
});
