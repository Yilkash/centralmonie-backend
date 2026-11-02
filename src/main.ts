import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureApp, createAdapter } from './app';
import { AppModule } from './app.module';
import { Env } from './config/env';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter());
  await configureApp(app);
  await app.listen({
    port: app.get(ConfigService<Env, true>).get('PORT', { infer: true }),
    host: '0.0.0.0',
  });
}

void main();
