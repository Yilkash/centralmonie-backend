#!/usr/bin/env node
// The hosted 10kobo MCP server: Streamable HTTP at /mcp, for Claude and ChatGPT connectors and any MCP client.
// Stateless: each request gets a fresh server, so it can run as several copies and restart freely.
// It uses no API key, so the no-key limits apply and account names stay partly hidden. No tool can move money.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TenKoboClient } from './client.ts';
import { buildServer } from './server.ts';

const PORT = Number(process.env.PORT ?? 4020);
const MAX_BODY = 64 * 1024;
const client = new TenKoboClient({ baseUrl: process.env.TENKOBO_API_URL ?? 'http://localhost:4010' });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
};

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('not json'));
      }
    });
    request.on('error', reject);
  });
}

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(body));
};
const rpcError = (response: ServerResponse, status: number, message: string) => reply(response, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });

export function createMcpHttpServer() {
  return createServer(async (request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'OPTIONS') return void response.writeHead(204, CORS).end();
    if (path === '/health') return reply(response, 200, { ok: true });
    if (path !== '/mcp') return reply(response, 404, { message: 'The MCP endpoint is /mcp.' });
    // Stateless: there is no stream to open or session to end.
    if (request.method !== 'POST') return rpcError(response, 405, 'Method not allowed. Send JSON-RPC with POST.');
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return rpcError(response, 400, 'The request body must be JSON, at most 64 KB.');
    }
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    for (const [name, value] of Object.entries(CORS)) response.setHeader(name, value);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) rpcError(response, 500, 'The MCP server could not handle that request.');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMcpHttpServer().listen(PORT, () => console.log(`10kobo MCP on http://localhost:${PORT}/mcp`));
}
