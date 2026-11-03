// Creates the two test-network wallets chain mode needs, and adds them to .env without printing any key.
// Test money only: refuses if .env points at a real network. Safe to run twice: existing values are kept.
import { appendFileSync, readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const env = readFileSync('.env', 'utf8');
const value = (name) => env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
if (value('CHAIN_ID') && value('CHAIN_ID') !== '84532') throw new Error('This script is for Base Sepolia only.');

const added = [];
const keyFor = (name) => {
  const existing = value(name);
  if (existing) return existing;
  const key = generatePrivateKey();
  added.push(`${name}=${key}`);
  return key;
};
const collection = privateKeyToAccount(keyFor('COLLECTION_KEY')).address;
const server = privateKeyToAccount(keyFor('SERVER_OWNER_KEY')).address;
if (!value('COLLECTION_ADDRESS')) added.push(`COLLECTION_ADDRESS=${collection}`);
if (added.length) appendFileSync('.env', `\n${added.join('\n')}\n`);

console.log('Send a little Base Sepolia ETH to each of these, for gas:');
console.log(`  Collection (signs refunds): ${collection}`);
console.log(`  Server owner (runs scheduled payments): ${server}`);
console.log('Then set PAYMENTS_MODE=chain in .env and restart the backend.');
