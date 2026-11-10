import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TenKoboClient, TenKoboError } from './client.ts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

async function guarded(run: () => Promise<unknown>) {
  try {
    return text(await run());
  } catch (error) {
    const message = error instanceof TenKoboError ? `${error.code}: ${error.message}` : 'The request failed. Nothing was sent.';
    return { ...text(message), isError: true };
  }
}

/** Read and arrange only: no tool here can move money. The agent's own wallet sends the USDC. */
export function buildServer(client: TenKoboClient): McpServer {
  const server = new McpServer({ name: '10kobo', version: '0.1.0' });

  server.registerTool(
    'quote_naira_payment',
    {
      description: "Prices paying a Nigerian bank account in naira, in USDC from the chain you hold it on, and returns the bank's name for the account, partly hidden when no API key is used. Moves nothing. Compare the name with who you mean to pay before accepting.",
      inputSchema: {
        amount_naira: z.number().int().positive(),
        bank_name: z.string().min(2),
        account_number: z.string().regex(/^\d{10}$/),
        pay_from: z.enum(['base', 'near', 'arbitrum', 'ethereum', 'solana']),
        refund_to: z.string().min(2).describe('Your own address on pay_from, which gets any refund.'),
        payer_name: z.string().min(2).describe('The person or company this agent acts for.'),
        payer_email: z.string().email(),
        purpose: z.string().min(3).describe('What the payment is for.'),
      },
      annotations: { title: 'Quote a naira payment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => guarded(() => client.quote(input)),
  );

  server.registerTool(
    'accept_quote',
    {
      description: 'Accepts a quote and returns the exact USDC to send and the one-time address to send it to. Moves nothing by itself: your own wallet must then send it. Send exactly this amount, only on this network, before the time given.',
      inputSchema: {
        payment_id: z.string().uuid(),
        refund_to: z.string().min(2).optional().describe('The same refund address you gave in the quote. Needed on the hosted server.'),
      },
      annotations: { title: 'Accept a quote', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ payment_id, refund_to }) => guarded(() => client.accept(payment_id, refund_to)),
  );

  server.registerTool(
    'check_payment',
    {
      description: 'Reports where a payment is, and gives the receipt once it is paid. Give tx_hash after sending the USDC.',
      inputSchema: { payment_id: z.string().uuid(), tx_hash: z.string().optional() },
      annotations: { title: 'Check a payment', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ payment_id, tx_hash }) => guarded(() => client.status(payment_id, tx_hash)),
  );

  return server;
}
