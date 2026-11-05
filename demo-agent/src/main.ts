import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runAgent, type Model } from './agent.ts';
import { TenKoboApi, X402Api } from './api.ts';
import { GaslessNearWallet, NearWallet, SimulatedWallet, type Wallet } from './wallet.ts';

// Reads only the settings it names, so the rest of an env file never reaches this program.
function settings(path: string | undefined, names: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (path) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && names.includes(match[1]!)) found[match[1]!] = match[2]!.trim();
    }
  }
  for (const name of names) if (process.env[name]) found[name] = process.env[name]!;
  return found;
}

const [invoicePath, ...flags] = process.argv.slice(2);
if (!invoicePath) {
  console.log('Usage: npm run demo -- invoices/normal.txt [--x402] [--real] [--gasless]');
  process.exit(1);
}
const real = flags.includes('--real');
const env = settings(process.env.AGENT_ENV_FILE, ['ANTHROPIC_API_KEY', 'AGENT_MODEL', 'TENKOBO_API_URL', 'TENKOBO_API_KEY', 'NEAR_AGENT_ACCOUNT_ID', 'NEAR_AGENT_PRIVATE_KEY', 'INVOICE_SUPPLIER', 'INVOICE_BANK', 'INVOICE_ACCOUNT', 'INVOICE_NAIRA', 'INVOICE_NUMBER', 'BUDGET_USDC', 'ALLOWED_ACCOUNTS']);
const need = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const model: Model = async ({ system, tools, messages }) =>
  (await anthropic.messages.create({ model: env.AGENT_MODEL ?? 'claude-haiku-5-5', max_tokens: 2000, system, tools, messages: messages as Anthropic.MessageParam[] })) as unknown as { content: never[] };

const realWallet: Wallet = !real
  ? new SimulatedWallet()
  : flags.includes('--gasless')
    ? new GaslessNearWallet({ accountId: need('NEAR_AGENT_ACCOUNT_ID'), privateKey: need('NEAR_AGENT_PRIVATE_KEY'), baseUrl: env.TENKOBO_API_URL ?? 'http://localhost:4010', key: env.TENKOBO_API_KEY })
    : new NearWallet(need('NEAR_AGENT_ACCOUNT_ID'), need('NEAR_AGENT_PRIVATE_KEY'));
const common = { baseUrl: env.TENKOBO_API_URL ?? 'http://localhost:4010', payFrom: 'near', refundTo: env.NEAR_AGENT_ACCOUNT_ID ?? 'demo-agent.near' };
const api = flags.includes('--x402')
  ? new X402Api({ ...common, ...(env.TENKOBO_API_KEY ? { key: env.TENKOBO_API_KEY } : {}), payer: { payer_name: '10kobo demo agent', payer_email: 'demo@example.com', purpose: 'Supplier invoice' } })
  : new TenKoboApi({ ...common, key: need('TENKOBO_API_KEY') });
const fill = (text: string) =>
  text
    .replaceAll('{{SUPPLIER}}', env.INVOICE_SUPPLIER ?? 'SIMULATED HOLDER 4568')
    .replaceAll('{{BANK}}', env.INVOICE_BANK ?? 'OPay')
    .replaceAll('{{ACCOUNT}}', env.INVOICE_ACCOUNT ?? '8031234568')
    .replaceAll('{{NAIRA}}', env.INVOICE_NAIRA ?? '1400')
    .replaceAll('{{NUMBER}}', env.INVOICE_NUMBER ?? '1042');

const invoice = fill(readFileSync(invoicePath, 'utf8'));

// With real money, one invoice pays once, even if this program is run again. Written before the send: if the
// send fails midway it may still have gone, so a person decides. Delete the entry to pay it again on purpose.
const LEDGER = '.paid-invoices.json';
const invoiceId = createHash('sha256').update(invoice).digest('hex');
const ledger: string[] = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
if (real && ledger.includes(invoiceId)) {
  console.log('This invoice has already been sent a payment. Nothing was sent.');
  process.exit(1);
}
const wallet: Wallet = {
  sendUsdc: (to, usdcMinor, paymentId) => {
    if (real) writeFileSync(LEDGER, JSON.stringify([...ledger, invoiceId]));
    return realWallet.sendUsdc(to, usdcMinor, paymentId);
  },
};

const events = flags.includes('--events');
const emit = (event: Record<string, unknown>) => {
  if (events) console.log(`EVENT ${JSON.stringify(event)}`);
};
emit({ type: 'started', budget: env.BUDGET_USDC ?? '2', real, gasless: flags.includes('--gasless'), x402: flags.includes('--x402'), keyless: !env.TENKOBO_API_KEY });

const result = await runAgent({
  model,
  api,
  wallet,
  ...(env.ALLOWED_ACCOUNTS ? { allowedAccounts: env.ALLOWED_ACCOUNTS.split(',').map((item) => item.trim()) } : {}),
  budgetUsdc: env.BUDGET_USDC ?? '2',
  task: "Pay this month's supplier invoice.",
  invoice,
  log: (line) => {
    if (!events) console.log(line);
  },
  event: emit,
  ...(real ? {} : { pollMs: 200 }),
});
emit({ type: 'result', outcome: result.outcome, reason: result.reason, receipt: result.payment?.receipt ?? null, transactions: (result.payment as { transactions?: string[] } | undefined)?.transactions ?? [] });
if (!events) console.log(`\nRESULT: ${result.outcome}. ${result.reason}`);
if (!events && result.payment?.receipt) console.log('RECEIPT:', JSON.stringify(result.payment.receipt, null, 2));
