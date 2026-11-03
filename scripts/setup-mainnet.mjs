// Creates .env.mainnet: new wallets, a new database, and the partner keys moved out of .env.
// Prints addresses only. Run once: node scripts/setup-mainnet.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

if (existsSync('.env.mainnet')) throw new Error('.env.mainnet already exists. Delete nothing; edit it by hand.');
const test = dotenv.parse(readFileSync('.env'));
const collectionKey = generatePrivateKey();
const serverKey = generatePrivateKey();
const collection = privateKeyToAddress(collectionKey);
const server = privateKeyToAddress(serverKey);

const lines = {
  PORT: test.PORT ?? '4010',
  DATABASE_URL: test.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/tenkobo_mainnet$1'),
  CORS_ORIGINS: test.CORS_ORIGINS,
  PRIVY_APP_ID: test.PRIVY_APP_ID,
  PRIVY_APP_SECRET: test.PRIVY_APP_SECRET,
  PRIVY_VERIFICATION_KEY: test.PRIVY_VERIFICATION_KEY,
  ANTHROPIC_API_KEY: test.ANTHROPIC_API_KEY,
  AGENT_MODEL: test.AGENT_MODEL,
  CHAIN_ID: '8453',
  CHAIN_RPC_URL: 'https://mainnet.base.org',
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ALLOW_REAL_MONEY: 'I understand this moves real money',
  PAYMENTS_MODE: 'chain',
  REQUIRE_PIN: 'true',
  COMPANY_DAILY_CAP_NAIRA: '50000',
  ADMIN_TOKEN: randomBytes(24).toString('hex'),
  COLLECTION_ADDRESS: collection,
  COLLECTION_KEY: collectionKey,
  SERVER_OWNER_KEY: serverKey,
  PAYSCRIBE_BASE_URL: 'https://api.payscribe.ng/api/v1/',
  PAYSCRIBE_SECRET_KEY: test.PAYSCRIBE_SECRET_KEY,
  SWITCH_BASE_URL: test.SWITCH_BASE_URL,
  SWITCH_API_KEY: test.SWITCH_API_KEY,
  SWITCH_REFUND_ADDRESS: collection,
  SWITCH_SANDBOX: 'false',
};
writeFileSync('.env.mainnet', Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });

// The test settings must never hold a live key, so a restart there stays harmless.
const remaining = readFileSync('.env', 'utf8').split('\n').filter((line) => !/^(PAYSCRIBE_BASE_URL|PAYSCRIBE_SECRET_KEY|SWITCH_BASE_URL|SWITCH_API_KEY|SWITCH_REFUND_ADDRESS|SWITCH_SANDBOX)=/.test(line));
writeFileSync('.env', remaining.join('\n'), { mode: 0o600 });
console.log('Collection wallet:', collection);
console.log('Server owner wallet:', server);
