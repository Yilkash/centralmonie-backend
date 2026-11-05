import cors from '@fastify/cors';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Env } from './config/env';

// Behind a host's proxy every request looks like it comes from the proxy, unless told how many proxies to trust.
// A number, not true: the left of X-Forwarded-For is written by the caller, who could then pick any address.
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
export const createAdapter = () => new FastifyAdapter({ bodyLimit: 64 * 1024, ...(proxyHops > 0 ? { trustProxy: proxyHops } : {}) });

/** Shared by the real server and the end-to-end tests, so they behave alike. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const origins = app.get(ConfigService<Env, true>).get('CORS_ORIGINS', { infer: true });
  await app.register(cors, {
    origin: (origin: string | undefined, done: (error: Error | null, allow: boolean) => void) =>
      done(null, origin !== undefined && origins.includes(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.enableShutdownHooks();
}
