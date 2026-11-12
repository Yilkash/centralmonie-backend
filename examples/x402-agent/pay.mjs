// An AI agent paying a Nigerian bank account through 10kobo with the official x402 client (scheme exact on NEAR).
//   node pay.mjs preview   asks for the price and the account name only. Nothing moves.
//   node pay.mjs pay       pays for real.
// Settings come from the environment, so no key or account number is written here:
//   NEAR_AGENT_ACCOUNT_ID, NEAR_AGENT_PRIVATE_KEY  the agent's NEAR account (needs USDC, no NEAR for gas)
//   PAY_BANK, PAY_ACCOUNT, PAY_NAIRA                 who to pay and how much
//   API                                              defaults to the live site
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createClientNearSigner } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';

const API = process.env.API ?? 'https://api.10kobo.xyz';
const accountId = process.env.NEAR_AGENT_ACCOUNT_ID;
const secretKey = process.env.NEAR_AGENT_PRIVATE_KEY;
if (!accountId || !secretKey) throw new Error('Set NEAR_AGENT_ACCOUNT_ID and NEAR_AGENT_PRIVATE_KEY.');
if (!process.env.PAY_BANK || !process.env.PAY_ACCOUNT) throw new Error('Set PAY_BANK and PAY_ACCOUNT.');

const request = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    amount_naira: Number(process.env.PAY_NAIRA ?? 1400),
    bank_name: process.env.PAY_BANK,
    account_number: process.env.PAY_ACCOUNT,
    pay_from: 'near',
    refund_to: accountId,
    payer_name: '10kobo demo agent',
    payer_email: 'agent@10kobo.xyz',
    purpose: 'x402 demo payment',
  }),
};
const decode = (value) => (value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null);
const mode = process.argv[2];

if (mode === 'preview') {
  const res = await fetch(`${API}/v1/agent/x402/pay`, request);
  const body = await res.json();
  console.log('status ', res.status);
  if (res.status !== 402) {
    console.log(body);
    process.exit(0);
  }
  const offer = decode(res.headers.get('payment-required')).accepts[0];
  console.log('offer  ', { scheme: offer.scheme, network: offer.network, usdc: Number(offer.amount) / 1e6 });
  console.log('payee  ', { name: body.payment.account_name, bank: body.payment.bank_name, account: body.payment.account_number, naira: body.payment.amount_naira });
} else if (mode === 'pay') {
  const client = new x402Client();
  client.register('near:*', new ExactNearScheme(createClientNearSigner({ accountId, secretKey })));
  client.setSpendControls({ maxAmountPerPayment: '$2' }); // the official client refuses over $1 unless raised
  const res = await wrapFetchWithPayment(fetch, client)(`${API}/v1/agent/x402/pay`, request);
  const body = await res.json();
  console.log('status ', res.status);
  console.log('settled', decode(res.headers.get('payment-response')));
  console.log('payment', { id: body.payment?.id, status: body.payment?.status, naira: body.payment?.amount_naira, to: body.payment?.account_name, code: body.code, message: body.message });
} else {
  console.log('Use: node pay.mjs preview | pay');
}
