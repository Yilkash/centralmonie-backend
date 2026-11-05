import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AgentPayment } from '../database/schema';
import { PayFrom } from './cross-chain';

/**
 * x402 version 2, with the `exact` scheme and the `near-intents` method in its upfront flow, as drafted in
 * x402-foundation/x402 pull request 3370, which is not final. Where this differs from the draft:
 * destination.recipient stays empty until quoted, because the partner's address is made when the payment is
 * accepted, and an API key is still required, so that every payment has an owner and limits.
 */
const ORIGIN: Record<PayFrom, { network: string; asset: string }> = {
  base: { network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  near: { network: 'near:mainnet', asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
  arbitrum: { network: 'eip155:42161', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  ethereum: { network: 'eip155:1', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  solana: { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};
const DESTINATION = ORIGIN.base;
const GRACE_SECONDS = 24 * 60 * 60;
const DEPOSIT_WINDOW_SECONDS = 30 * 60;

const payloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string() }),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('quote'), refundTo: z.string() }),
    z.object({ type: z.literal('deposit'), operationToken: z.string(), depositAddress: z.string(), txHash: z.string().min(1) }),
  ]),
});
export type X402Payload = z.infer<typeof payloadSchema>;

export const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

export function decodeSignature(header: string): X402Payload | null {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const destination = (payment: AgentPayment) => ({ network: DESTINATION.network, asset: DESTINATION.asset, amount: String(payment.usdcMinor), recipient: payment.payoutAddress ?? '' });
const origin = (payment: AgentPayment) => ORIGIN[payment.payFrom as PayFrom];

function unquoted(payment: AgentPayment) {
  return {
    scheme: 'exact',
    ...origin(payment),
    amount: '',
    payTo: '',
    maxTimeoutSeconds: DEPOSIT_WINDOW_SECONDS,
    extra: { assetTransferMethod: 'near-intents', paymentFlow: 'upfront', indicativeAmount: String(payment.payInMinor), destination: destination(payment) },
  };
}

export function operationToken(secret: string, payment: AgentPayment, resource: string, expiry: number): string {
  const destinationHash = createHash('sha256').update(`${DESTINATION.network}:${DESTINATION.asset}:${payment.usdcMinor}:${payment.payoutAddress}`).digest('hex');
  const mac = createHmac('sha256', secret).update(`${origin(payment).network}:${payment.depositAddress}:${resource}:${destinationHash}:${expiry}`).digest('base64url');
  return `k1.${expiry}.${mac}`;
}

export type TokenProblem = 'invalid_exact_near_intents_token_invalid' | 'invalid_exact_near_intents_token_expired';

export function tokenProblem(secret: string, payment: AgentPayment, resource: string, token: string, now = Date.now()): TokenProblem | null {
  const [, expiryText] = token.split('.');
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry)) return 'invalid_exact_near_intents_token_invalid';
  const expected = Buffer.from(operationToken(secret, payment, resource, expiry));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid_exact_near_intents_token_invalid';
  return expiry * 1000 <= now ? 'invalid_exact_near_intents_token_expired' : null;
}

export function firstChallenge(payment: AgentPayment, url: string) {
  return { x402Version: 2, resource: { url, description: `Pay ${payment.accountName} in naira`, mimeType: 'application/json' }, accepts: [unquoted(payment)] };
}

export function quotedChallenge(secret: string, payment: AgentPayment, url: string, resource: string) {
  const deadline = payment.depositDeadline!;
  const expiry = Math.floor(deadline.getTime() / 1000) + GRACE_SECONDS;
  const entry = unquoted(payment);
  return {
    x402Version: 2,
    resource: { url, description: `Pay ${payment.accountName} in naira`, mimeType: 'application/json' },
    accepts: [{ ...entry, amount: String(payment.payInMinor), payTo: payment.depositAddress!, extra: { ...entry.extra, refundDeadline: deadline.toISOString(), operationToken: operationToken(secret, payment, resource, expiry) } }],
  };
}

export function settlement(payment: AgentPayment, txHash: string) {
  const { network } = origin(payment);
  if (payment.status === 'paid') {
    return { success: true, network: DESTINATION.network, transaction: payment.transactions.at(-1) ?? '', payer: payment.refundTo, amount: String(payment.usdcMinor), extra: { originNetwork: network, originTxHash: txHash } };
  }
  if (['refunded', 'expired', 'needs_support'].includes(payment.status)) {
    return { success: false, errorReason: 'exact_near_intents_payment_failed', network, transaction: '', extra: { status: payment.status, refundTo: payment.refundTo } };
  }
  return { success: false, errorReason: 'settlement_pending', network, transaction: txHash, extra: { status: payment.status } };
}

/** Whether this transaction is one the payment really involved. Test mode has no real transactions to compare. */
export function provesPayment(payment: AgentPayment, txHash: string): boolean {
  return payment.transactions.length === 0 || payment.transactions.includes('simulated') || payment.transactions.includes(txHash);
}
