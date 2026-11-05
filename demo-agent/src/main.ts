import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { runAgent, type Model } from './agent.ts';
import { TenKoboApi } from './api.ts';
import { NearWallet, SimulatedWallet, type Wallet } from './wallet.ts';

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
  console.log('Usage: npm run demo -- invoices/normal.txt [--real]');
  process.exit(1);
}
const real = flags.includes('--real');
const env = settings(process.env.AGENT_ENV_FILE, ['ANTHROPIC_API_KEY', 'AGENT_MODEL', 'TENKOBO_API_URL', 'TENKOBO_API_KEY', 'NEAR_AGENT_ACCOUNT_ID', 'NEAR_AGENT_PRIVATE_KEY', 'INVOICE_SUPPLIER', 'INVOICE_BANK', 'INVOICE_ACCOUNT', 'INVOICE_NAIRA', 'BUDGET_USDC']);
const need = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const model: Model = async ({ system, tools, messages }) =>
  (await anthropic.messages.create({ model: env.AGENT_MODEL ?? 'claude-haiku-5-5', max_tokens: 2000, system, tools, messages: messages as Anthropic.MessageParam[] })) as unknown as { content: never[] };

const wallet: Wallet = real ? new NearWallet(need('NEAR_AGENT_ACCOUNT_ID'), need('NEAR_AGENT_PRIVATE_KEY')) : new SimulatedWallet();
const api = new TenKoboApi({ baseUrl: env.TENKOBO_API_URL ?? 'http://localhost:4010', key: need('TENKOBO_API_KEY'), payFrom: 'near', refundTo: env.NEAR_AGENT_ACCOUNT_ID ?? 'demo-agent.near' });
const fill = (text: string) =>
  text
    .replaceAll('{{SUPPLIER}}', env.INVOICE_SUPPLIER ?? 'SIMULATED HOLDER 4568')
    .replaceAll('{{BANK}}', env.INVOICE_BANK ?? 'OPay')
    .replaceAll('{{ACCOUNT}}', env.INVOICE_ACCOUNT ?? '8031234568')
    .replaceAll('{{NAIRA}}', env.INVOICE_NAIRA ?? '1400');

const result = await runAgent({
  model,
  api,
  wallet,
  budgetUsdc: env.BUDGET_USDC ?? '2',
  task: "Pay this month's supplier invoice.",
  invoice: fill(readFileSync(invoicePath, 'utf8')),
  log: (line) => console.log(line),
  ...(real ? {} : { pollMs: 200 }),
});
console.log(`\nRESULT: ${result.outcome}. ${result.reason}`);
if (result.payment?.receipt) console.log('RECEIPT:', JSON.stringify(result.payment.receipt, null, 2));
