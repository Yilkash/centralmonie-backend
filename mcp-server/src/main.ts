#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TenKoboClient } from './client.ts';
import { buildServer } from './server.ts';

const client = new TenKoboClient({ baseUrl: process.env.TENKOBO_API_URL ?? 'http://localhost:4010', key: process.env.TENKOBO_API_KEY });
await buildServer(client).connect(new StdioServerTransport());
