import cors from '@fastify/cors';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Env } from './config/env';

export const createAdapter = () => new FastifyAdapter({ bodyLimit: 64 * 1024 });

/** Shared by the real server and the end-to-end tests, so they behave alike. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const origins = app.get(ConfigService<Env, true>).get('CORS_ORIGINS', { infer: true });
  await app.register(cors, {
    origin: (origin: string | undefined, done: (error: Error | null, allow: boolean) => void) =>
      done(null, origin !== undefined && origins.includes(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.enableShutdownHooks();
}
