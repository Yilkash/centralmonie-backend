// Starts the local chain for the browser tests, funds the test wallet, and writes the settings the tests need.
import { writeFileSync } from 'node:fs';
import { address, dealUsdc, KEYS, smartWallet, startFork, syncClock, test } from './fork';

async function main(): Promise<void> {
  await startFork();
  for (const key of Object.values(KEYS)) await test.setBalance({ address: address(key), value: 10n ** 19n });
  const wallet = await smartWallet(KEYS.user);
  await dealUsdc(wallet, 50_000_000n);
  await syncClock();
  writeFileSync(
    process.argv[2]!,
    [
      `WALLET=${wallet}`,
      `OWNER_KEY=${KEYS.user}`,
      `COLLECTION=${address(KEYS.collection)}`,
      `COLLECTION_KEY=${KEYS.collection}`,
      `SERVER_KEY=${KEYS.server}`,
      '',
    ].join('\n'),
  );
  setInterval(() => undefined, 60_000);
}

void main();
