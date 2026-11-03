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
  // A partner goes live for its route when its key is set. Sandbox URLs until Phase 6.
  PAYSCRIBE_BASE_URL: z.string().url().optional(),
  PAYSCRIBE_SECRET_KEY: z.string().min(1).optional(),
  SWITCH_BASE_URL: z.string().url().optional(),
  SWITCH_API_KEY: z.string().min(1).optional(),
  SWITCH_WEBHOOK_SECRET: z.string().min(1).optional(),
  SWITCH_CALLBACK_URL: z.string().url().optional(),
  SWITCH_ONRAMP_CALLBACK_URL: z.string().url().optional(),
  SWITCH_REFUND_ADDRESS: z.string().optional(),
  // Asks for the user's PIN on every approval and new recipient. Turn on before real money.
  REQUIRE_PIN: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  // All users together, per day. A bug or an attack cannot move more than this.
  COMPANY_DAILY_CAP_NAIRA: z.coerce.number().int().positive().default(5_000_000),
  // Opens the admin API. Without it, the admin API refuses everyone.
  ADMIN_TOKEN: z.string().min(24).optional(),
  // Lets the web app's gas proxy ask whether a wallet belongs to one of our users.
  SPONSORSHIP_TOKEN: z.string().min(24).optional(),
  // Timers for deposits, reconciliation and schedules. Off in unit tests.
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
});

export type Env = z.infer<typeof envSchema>;

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
  // In simulated mode no USDC is collected, so a real partner would be paying out for free.
  if (result.data.PAYMENTS_MODE === 'simulated' && (result.data.PAYSCRIBE_SECRET_KEY || result.data.SWITCH_API_KEY)) {
    throw new Error('Partner keys need PAYMENTS_MODE=chain');
  }
  if (result.data.CHAIN_ID === 8453 && !result.data.REQUIRE_PIN) {
    throw new Error('Real money needs REQUIRE_PIN=true');
  }
  if (result.data.PAYMENTS_MODE === 'chain' && !result.data.COLLECTION_ADDRESS) {
    throw new Error('PAYMENTS_MODE=chain needs COLLECTION_ADDRESS');
  }
  return result.data;
}
