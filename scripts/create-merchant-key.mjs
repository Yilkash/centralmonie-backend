#!/usr/bin/env node
// Makes a merchant key through the running backend's admin route, and writes the key and notice secret straight
// into an env file, so neither is ever printed. Only the key's id is shown, for revoking it later.
//
//   DOTENV_CONFIG_PATH=.env.mainnet node -r dotenv/config scripts/create-merchant-key.mjs \
//     --email you@example.com --name "Mama Put Kitchen" --bank OPay --account 0123456789 \
//     (or --wallet, --usdc-address 0x… or --near-account name.near instead of --bank and --account)
//     --origin http://localhost:3010 --webhook http://localhost:3010/shop/api/notices --env-out ../10kobo-frontend/.env.mainnet
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    bank: { type: 'string' },
    account: { type: 'string' },
    wallet: { type: 'boolean', default: false },
    'usdc-address': { type: 'string' },
    'near-account': { type: 'string' },
    origin: { type: 'string', multiple: true, default: [] },
    webhook: { type: 'string' },
    'env-out': { type: 'string' },
    api: { type: 'string', default: `http://localhost:${process.env.PORT ?? 4010}` },
  },
});
const payouts = [values.wallet, values['usdc-address'], values['near-account'], values.bank && values.account].filter(Boolean).length;
if (!values.email || !values.name || !values['env-out'] || payouts !== 1) {
  console.error('Needs --email, --name, --env-out, and one payout: --bank with --account, --wallet, --usdc-address or --near-account');
  process.exit(1);
}
if (!process.env.ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is not set. Load the backend env file first.');
  process.exit(1);
}
const existing = readFileSync(values['env-out'], 'utf8');
if (/^SHOP_MERCHANT_KEY=/m.test(existing)) {
  console.error(`${values['env-out']} already has SHOP_MERCHANT_KEY. Revoke the old key and remove those lines first.`);
  process.exit(1);
}

const response = await fetch(`${values.api}/v1/admin/merchant-keys`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    user_email: values.email,
    name: values.name,
    payout: values.wallet
      ? { to_my_wallet: true }
      : values['usdc-address']
        ? { usdc_address: values['usdc-address'] }
        : values['near-account']
          ? { near_account: values['near-account'] }
          : { bank_name: values.bank, account_number: values.account },
    return_origins: values.origin,
    webhook_url: values.webhook ?? null,
  }),
});
const made = await response.json();
if (!response.ok) {
  console.error(`Refused: ${made.message ?? response.status}`);
  process.exit(1);
}
appendFileSync(
  values['env-out'],
  `\n# Demo shop (/shop): its merchant key, made ${new Date().toISOString().slice(0, 10)} with id ${made.id}. Secret: never share or commit.\n` +
    `SHOP_MERCHANT_KEY=${made.key}\n` +
    (made.webhook_secret ? `# Checks that notices to /shop/api/notices really came from 10kobo.\nSHOP_WEBHOOK_SECRET=${made.webhook_secret}\n` : ''),
);
console.log(`Merchant key made, id ${made.id}. The key and secret were written to ${values['env-out']}.`);
