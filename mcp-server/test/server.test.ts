import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TenKoboClient } from '../src/client.ts';
import { buildServer } from '../src/server.ts';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/http.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const INPUT = { amount_naira: 1400, bank_name: 'OPay', account_number: '8031234568', pay_from: 'near', refund_to: 'agent.near', payer_name: 'Ada Motors', payer_email: 'ada@example.com', purpose: 'Invoice 1' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString());
const offer = { accepts: [{ amount: '1052400', network: 'near:mainnet', payTo: '0xdeposit', extra: { assetTransferMethod: 'near-intents', refundDeadline: '2026-11-06T00:00:00Z', operationToken: 'k1.9.secret' } }] };

describe('the 10kobo MCP server', () => {
  let calls: { url: string; headers: Record<string, string>; body: unknown }[];
  let answer: (url: string) => Response;
  let mcp: Client;

  const connect = async (key?: string) => {
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return answer(url);
    }) as unknown as typeof fetch;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer(new TenKoboClient({ baseUrl: 'https://api.test/', key, fetchFn })).connect(a);
    mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(b);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError ?? false };
  };

  beforeEach(() => {
    calls = [];
    answer = (url) => (url.endsWith('/pay') ? new Response(JSON.stringify({ payment: { id: ID, status: 'quoted', account_name: 'Ad* Be***', pay_usdc: '1.052400' } }), { status: 402 }) : new Response(JSON.stringify({ payment: { id: ID, status: 'awaiting_deposit' } }), { status: 402, headers: { 'PAYMENT-REQUIRED': encode(offer) } }));
  });

  it('offers exactly three tools, and none can send money', async () => {
    await connect();
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['quote_naira_payment', 'accept_quote', 'check_payment']);
  });

  it('quotes with no key, then gives the exact amount and address, keeping the token away from the model', async () => {
    await connect();
    const quote = await call('quote_naira_payment', INPUT);
    assert.match(quote.text, /Ad\* Be\*\*\*/);
    assert.equal(calls[0]!.headers.authorization, undefined);
    const accepted = await call('accept_quote', { payment_id: ID });
    assert.deepEqual(JSON.parse(accepted.text), { payment_id: ID, pay_exact_usdc: '1.052400', to_address: '0xdeposit', network: 'near:mainnet', send_before: '2026-11-06T00:00:00Z' });
    assert.doesNotMatch(accepted.text, /secret/);
    assert.deepEqual(decode(calls[1]!.headers['payment-signature']!).payload, { type: 'quote', refundTo: 'agent.near' });
  });

  it('sends the key when it has one', async () => {
    await connect('10k_key');
    await call('quote_naira_payment', INPUT);
    assert.equal(calls[0]!.headers.authorization, 'Bearer 10k_key');
  });

  it('proves the deposit when checking, and returns the receipt', async () => {
    await connect();
    await call('quote_naira_payment', INPUT);
    await call('accept_quote', { payment_id: ID });
    answer = () => new Response(JSON.stringify({ payment: { id: ID, status: 'paid', receipt: { reference: ID } }, settlement: { success: true } }));
    const done = await call('check_payment', { payment_id: ID, tx_hash: '0xa' });
    assert.deepEqual(decode(calls.at(-1)!.headers['payment-signature']!).payload, { type: 'deposit', operationToken: 'k1.9.secret', depositAddress: '0xdeposit', txHash: '0xa' });
    assert.match(done.text, /"receipt"/);
  });

  it('never offers an address for a payment that cannot be paid', async () => {
    await connect();
    await call('quote_naira_payment', INPUT);
    answer = () => new Response(JSON.stringify({ payment: { id: ID, status: 'paid' }, settlement: { success: true } }));
    const result = await call('accept_quote', { payment_id: ID });
    assert.equal(result.isError, true);
    assert.match(result.text, /not_payable/);
  });

  it('refuses a quote from another session, and passes on refusals with their code', async () => {
    await connect();
    assert.match((await call('accept_quote', { payment_id: ID })).text, /not_found/);
    answer = () => new Response(JSON.stringify({ code: 'over_payment_limit', message: 'Too much.' }), { status: 422 });
    const refused = await call('quote_naira_payment', INPUT);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /over_payment_limit: Too much/);
  });

  it('says nothing was sent when the network fails', async () => {
    await connect();
    answer = () => {
      throw new Error('private detail');
    };
    const result = await call('quote_naira_payment', INPUT);
    assert.match(result.text, /Nothing was sent/);
    assert.doesNotMatch(result.text, /private detail/);
  });
});

describe('the hosted MCP server', () => {
  it('answers on /mcp over Streamable HTTP, lists the three tools with their annotations, and refuses other paths', async () => {
    const http = createMcpHttpServer().listen(0);
    const port = (http.address() as { port: number }).port;
    try {
      const mcp = new Client({ name: 'test', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
      const { tools } = await mcp.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ['quote_naira_payment', 'accept_quote', 'check_payment']);
      assert.equal(tools.find((tool) => tool.name === 'check_payment')!.annotations!.readOnlyHint, true);
      assert.equal(tools.every((tool) => tool.annotations?.destructiveHint === false), true);
      await mcp.close();
      assert.equal((await fetch(`http://localhost:${port}/elsewhere`)).status, 404);
      assert.equal((await fetch(`http://localhost:${port}/mcp`)).status, 405);
      assert.equal((await fetch(`http://localhost:${port}/mcp`, { method: 'POST', body: 'not json' })).status, 400);
    } finally {
      http.close();
    }
  });

  it('accepts with refund_to given again, so a restarted server still works', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ payment: { id: ID, status: 'awaiting_deposit' } }), { status: 402, headers: { 'PAYMENT-REQUIRED': encode(offer) } })) as unknown as typeof fetch;
    const fresh = new TenKoboClient({ baseUrl: 'https://api.test/', fetchFn });
    const accepted = await fresh.accept(ID, 'agent.near');
    assert.equal(accepted.to_address, '0xdeposit');
    await assert.rejects(new TenKoboClient({ baseUrl: 'https://api.test/', fetchFn }).accept(ID), /refund_to/);
  });
});
