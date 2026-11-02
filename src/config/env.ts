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
});

export type Env = z.infer<typeof envSchema>;

/** Refuses to start on bad settings, naming the variable but never its value. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${names}`);
  }
  return result.data;
}
