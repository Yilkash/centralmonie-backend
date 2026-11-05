import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4010),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  PRIVY_VERIFICATION_KEY: z.string().min(1),
  // Without a key, the app runs with the placeholder reply and no AI.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  // 'test' accepts sign-ins with no check, for automated browser tests. Refused in production below.
  IDENTITY_PROVIDER: z.enum(['privy', 'test']).default('privy'),

  // simulated: approving pays at once and moves nothing. chain: the user signs and USDC really moves.
  PAYMENTS_MODE: z.enum(['simulated', 'chain']).default('simulated'),
  CHAIN_RPC_URL: z.string().url().default('https://sepolia.base.org'),
  CHAIN_ID: z.coerce.number().int().default(84532),
  USDC_ADDRESS: z.string().default('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  // Base mainnet (8453) means real money. It is refused unless this is exactly the phrase below.
  ALLOW_REAL_MONEY: z.string().optional(),
  // Where USDC goes for airtime, data and simulated bank payments.
  COLLECTION_ADDRESS: z.string().optional(),
  // Signs refunds from the collection address. Without it, a failed delivery goes to the support list.
  COLLECTION_KEY: z.string().optional(),
  // Owner key of the server smart account that runs scheduled payments.
  SERVER_OWNER_KEY: z.string().optional(),
  // Bundler and paymaster for that account. Set, the paymaster pays its gas. Unset, the owner key pays in ETH.
  SERVER_BUNDLER_URL: z.string().url().optional(),
  // A partner goes live for its route when its key is set. Sandbox URLs until Phase 6.
  PAYSCRIBE_BASE_URL: z.string().url().optional(),
  PAYSCRIBE_SECRET_KEY: z.string().min(1).optional(),
  SWITCH_BASE_URL: z.string().url().optional(),
  SWITCH_API_KEY: z.string().min(1).optional(),
  SWITCH_WEBHOOK_SECRET: z.string().min(1).optional(),
  SWITCH_CALLBACK_URL: z.string().url().optional(),
  SWITCH_ONRAMP_CALLBACK_URL: z.string().url().optional(),
  SWITCH_REFUND_ADDRESS: z.string().optional(),
  // Sandbox and live share one address and differ only by key, so the operator must say which key this is.
  SWITCH_SANDBOX: z.enum(['true', 'false']).optional(),
  // Asks for the user's PIN on every approval and new recipient. Turn on before real money.
  REQUIRE_PIN: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Lets real money run without a PIN. Only this exact phrase does.
  ALLOW_NO_PIN: z.string().optional(),
  // All users together, per day. A bug or an attack cannot move more than this.
  COMPANY_DAILY_CAP_NAIRA: z.coerce.number().int().positive().default(5_000_000),
  // Opens the Agent API when real money is on. In test mode it is always open, and moves nothing.
  AGENT_API_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // Lets agents pay over x402 with no API key when real money is on. In test mode it is always open.
  X402_KEYLESS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // How many proxies sit in front of the backend. Read as a real environment variable, before any .env file loads.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
  // Where people open the web app, for links we hand out. Defaults to the first of CORS_ORIGINS.
  PUBLIC_APP_URL: z.string().url().optional(),
  // Pays NEAR gas so agents paying from NEAR need only USDC. Without these, agents pay their own gas.
  NEAR_RELAYER_ACCOUNT_ID: z.string().min(2).optional(),
  NEAR_RELAYER_PRIVATE_KEY: z.string().min(10).optional(),
  NEAR_RPC_URL: z.string().url().default('https://rpc.mainnet.near.org'),
  // NEAR Intents' 1Click API. The key lowers the fee and is not required.
  ONECLICK_API_KEY: z.string().min(1).optional(),
  ONECLICK_BASE_URL: z.string().url().default('https://1click.chaindefuser.com'),
  // Our fee on payments through NEAR Intents, in basis points (100 = 1%), paid to this NEAR account. Off at 0.
  ONECLICK_FEE_BPS: z.coerce.number().int().min(0).max(400).default(0),
  ONECLICK_FEE_RECIPIENT: z.string().min(2).optional(),
  // Opens the admin API. Without it, the admin API refuses everyone.
  ADMIN_TOKEN: z.string().min(24).optional(),
  // Lets the web app's gas proxy ask whether a wallet belongs to one of our users.
  SPONSORSHIP_TOKEN: z.string().min(24).optional(),
  // Timers for deposits, reconciliation and schedules. Off in unit tests.
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
});

export type Env = z.infer<typeof envSchema>;

const MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** Refuses to start on bad settings, naming the variable but never its value. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${names}`);
  }
  if (result.data.IDENTITY_PROVIDER === 'test' && process.env.NODE_ENV === 'production') {
    throw new Error('IDENTITY_PROVIDER=test is not allowed in production');
  }
  if (result.data.CHAIN_ID !== 84532 && result.data.CHAIN_ID !== 31337 && result.data.ALLOW_REAL_MONEY !== 'I understand this moves real money') {
    throw new Error('CHAIN_ID is not a test network. Real money needs ALLOW_REAL_MONEY set');
  }
  const onTestNetwork = result.data.CHAIN_ID !== 8453;
  if (onTestNetwork && result.data.USDC_ADDRESS.toLowerCase() === MAINNET_USDC) throw new Error('USDC_ADDRESS is real USDC, on a test network');
  if (result.data.SWITCH_API_KEY) {
    // A live partner paying out against test USDC loses real naira. A sandbox partner on mainnet takes real USDC and pays nothing.
    if (onTestNetwork && result.data.SWITCH_SANDBOX !== 'true') throw new Error('SWITCH_SANDBOX must be true on a test network, with a sandbox key');
    if (!onTestNetwork && result.data.SWITCH_SANDBOX !== 'false') throw new Error('SWITCH_SANDBOX must be false on mainnet');
  }
  if (result.data.PAYSCRIBE_SECRET_KEY && onTestNetwork && !result.data.PAYSCRIBE_BASE_URL?.includes('sandbox')) {
    throw new Error('PAYSCRIBE_BASE_URL must be the sandbox on a test network');
  }
  // In simulated mode no USDC is collected, so a real partner would be paying out for free.
  if (result.data.PAYMENTS_MODE === 'simulated' && (result.data.PAYSCRIBE_SECRET_KEY || result.data.SWITCH_API_KEY)) {
    throw new Error('Partner keys need PAYMENTS_MODE=chain');
  }
  if (result.data.CHAIN_ID === 8453) {
    // With real money, a missing setting must stop the app, not quietly fall back to something simulated.
    const missing = (
      ['PAYSCRIBE_SECRET_KEY', 'PAYSCRIBE_BASE_URL', 'SWITCH_API_KEY', 'SWITCH_BASE_URL', 'SWITCH_REFUND_ADDRESS', 'SERVER_OWNER_KEY', 'COLLECTION_KEY', 'ADMIN_TOKEN'] as const
    ).filter((name) => !result.data[name]);
    if (missing.length) throw new Error(`Real money needs: ${missing.join(', ')}`);
    // Without a PIN, a signed-in session alone can approve payments, so turning it off must be deliberate.
    if (!result.data.REQUIRE_PIN && result.data.ALLOW_NO_PIN !== 'I understand approvals have no PIN') throw new Error('Real money needs REQUIRE_PIN=true');
    if (result.data.PAYMENTS_MODE !== 'chain') throw new Error('Real money needs PAYMENTS_MODE=chain');
    if (result.data.IDENTITY_PROVIDER !== 'privy') throw new Error('Real money needs the real sign-in');
    // The defaults point at the test network, so these would otherwise follow it without a word.
    if (result.data.USDC_ADDRESS.toLowerCase() !== MAINNET_USDC) throw new Error('Real money needs USDC_ADDRESS set to USDC on Base');
    if (/sepolia/i.test(result.data.CHAIN_RPC_URL)) throw new Error('Real money needs CHAIN_RPC_URL set to a Base mainnet RPC');
    if (result.data.PAYSCRIBE_BASE_URL?.includes('sandbox')) throw new Error('Real money needs the live PAYSCRIBE_BASE_URL');
  }
  if (result.data.ONECLICK_FEE_BPS > 0 && !result.data.ONECLICK_FEE_RECIPIENT) throw new Error('ONECLICK_FEE_BPS needs ONECLICK_FEE_RECIPIENT');
  // Behind a proxy with this unset, every caller looks like one address, and anyone could use up the limit for all.
  if (result.data.PAYMENTS_MODE === 'chain' && result.data.X402_KEYLESS_ENABLED && result.data.TRUST_PROXY_HOPS === undefined) {
    throw new Error('X402_KEYLESS_ENABLED needs TRUST_PROXY_HOPS set, even to 0');
  }
  if (result.data.PAYMENTS_MODE === 'chain' && !result.data.COLLECTION_ADDRESS) {
    throw new Error('PAYMENTS_MODE=chain needs COLLECTION_ADDRESS');
  }
  return result.data;
}
