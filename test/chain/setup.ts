import '../setup-env';
import { address, KEYS, RPC } from './fork';

// Settings are read when AppModule is imported, so they must be in place before the test file loads.
Object.assign(process.env, {
  PAYMENTS_MODE: 'chain',
  CHAIN_RPC_URL: RPC,
  COLLECTION_ADDRESS: address(KEYS.collection),
  COLLECTION_KEY: KEYS.collection,
  SERVER_OWNER_KEY: KEYS.server,
});
