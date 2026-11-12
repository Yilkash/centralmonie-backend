# 10kobo

**Dollars to any wallet. Naira to any bank. For people and AI agents.**

10kobo lets people, businesses and AI agents pay any Nigerian bank account with stablecoins, and get paid in naira or
USDC. Money moves between chains through **NEAR Intents**, and AI agents pay with **x402 on NEAR**: no sign-up, no
API key. It runs on mainnet with real money.

| | |
| --- | --- |
| Website | https://10kobo.xyz |
| Developer docs (no login) | https://10kobo.xyz/docs · for AI agents: https://10kobo.xyz/llms.txt |
| API | https://api.10kobo.xyz |
| Demo shop with the checkout widget | https://10kobo.xyz/shop |
| Real payments, with explorer links | https://10kobo.xyz/proof |
| X | [@10koboPay](https://x.com/10koboPay) |

This repository is the backend (NestJS API). The web app is
[blockfuselabs/10kobo-frontend](https://github.com/blockfuselabs/10kobo-frontend). Built at NEAR HACKATHON
(November 2026) for the **Real-World Money** and **Agent Economy** tracks.

## The problem

More and more Nigerians earn and hold USDC, and AI agents hold crypto. But rent, suppliers, school fees and salaries
are paid in naira, to a bank account. Getting from one to the other today means a P2P trader, a spread, a delay and
someone to trust. Going the other way, a customer with only naira cannot easily pay a business that wants USDC. And an
AI agent cannot pay a Nigerian bank account at all.

## What it does

| Who | What they can do |
| --- | --- |
| **A person** | Hold dollars (USDC) in their own wallet. Add money by naira bank transfer or from 14 other networks. Pay any Nigerian bank, buy airtime and data, or send USDC to 16 networks, just by typing it in a chat ("send 5,000 to my landlord at GTBank") or on the Send page |
| **A business** | Share a **payment link**, or paste a **checkout widget** into any website with no code. Customers pay by naira bank transfer or with crypto from 15 networks. The business is paid in its Nigerian bank account or in USDC. Developers can use **merchant keys** and **signed webhooks** instead |
| **An AI agent** | Pay a Nigerian bank account with **standard x402** from NEAR, with no account and no API key, or with one HTTP call and a key. It sees the account holder's name from the bank before paying, and needs no NEAR for gas. Assistants like Claude and ChatGPT can also connect through the **MCP server** |

Every quote shows the **real account holder's name from the bank** before money moves, so a wrong number is caught.
10kobo never holds the money in between: a payment goes from the payer's wallet through NEAR Intents and the payment
partner to the bank, or arrives in the receiver's own wallet.

## What NEAR does

| NEAR piece | Where 10kobo uses it | Code |
| --- | --- | --- |
| **x402, scheme `exact` on `near:mainnet`** | An AI agent pays with the **official x402 client** (`@x402/near`, `@x402/core`, `@x402/fetch`). The first request answers `402 Payment Required`; the agent signs one USDC transfer, 10kobo checks it with the official x402 NEAR verifier and settles it, and the naira goes to the bank | `src/agent-api/near-relay.ts`, `src/agent-api/agent-api.controller.ts` |
| **NEAR Intents (1Click API)** | Every move between chains: paying a bank, invoice or checkout from 15 networks, sending to 16 networks, and deposits from 14. Bank payments use exact-output quotes, so the bank receives the exact naira asked for | `src/agent-api/cross-chain.ts` |
| **Meta transactions (relayer)** | The agent signs a delegate action and 10kobo pays the gas, so the agent needs only USDC. The relayer pays only for a USDC transfer to that payment's own one-time deposit address | `src/agent-api/near-relay.ts` |
| **NEAR accounts** | Agents pay from NEAR; payment links and sends can deliver USDC to a `name.near` account. The prize account is `10kobo.near` | `src/chain/usdc-chains.ts` |
| **x402 with the `near-intents` method** | For agents paying from Base, Arbitrum, Ethereum or Solana, the same 402 also offers a NEAR Intents payment, following the draft in x402-foundation/x402 pull request 3370 (not final) | `src/agent-api/x402.ts` |

## See it working

### 1. An AI agent pays a Nigerian bank with x402 (real money)

The whole agent is about 10 lines, using only the official x402 packages: see
[`examples/x402-agent/pay.mjs`](examples/x402-agent/pay.mjs).

```js
const client = new x402Client();
client.register('near:*', new ExactNearScheme(createClientNearSigner({ accountId, secretKey })));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPayment('https://api.10kobo.xyz/v1/agent/x402/pay', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ amount_naira: 1400, bank_name: 'OPay', account_number: '0123456789', pay_from: 'near', refund_to: accountId, payer_name: '…', payer_email: '…', purpose: '…' }),
});
```

To see only the price and the account holder's name, with nothing paid, ask without a payment:

```
curl -i -X POST https://api.10kobo.xyz/v1/agent/x402/pay -H 'content-type: application/json' -d '{
  "amount_naira": 1400, "bank_name": "OPay", "account_number": "0123456789", "pay_from": "near",
  "refund_to": "agent.near", "payer_name": "Judge", "payer_email": "judge@example.com", "purpose": "Trying 10kobo"
}'
```

It answers `402 Payment Required`, with the standard `exact` offer on `near:mainnet` in the `PAYMENT-REQUIRED`
header. Use a real 10-digit account number: the quote checks the name with the bank. The offer expires by itself
if nobody pays.

### 2. A shop paid through NEAR Intents (real money)

Open https://10kobo.xyz/shop, add something to the basket and choose **Checkout with 10kobo**. Pick a network,
enter a refund address, and you get the exact USDC and a one-time address. Once the USDC arrives, NEAR Intents
settles it and the shop's bank account is paid in naira. The shop page shows "NEAR Intents settlement" and
"Delivery on Base" links when it is done.

### 3. The whole app on your machine, with no keys and no real money

Needs Node 22, Docker and Git. The test copy uses its own database and moves no money: sign-in is a test login,
bank and airtime payouts are simulated, and every simulated result says so.

```
mkdir 10kobo && cd 10kobo
git clone https://github.com/blockfuselabs/10kobo-backend.git
git clone https://github.com/blockfuselabs/10kobo-frontend.git
(cd 10kobo-backend && npm ci && npm run db:up)
(cd 10kobo-frontend && npm ci)
cd 10kobo-backend && ./scripts/demo-start.sh
```

When it prints "Test copy is ready", try these:

| Do this | See this |
| --- | --- |
| Open http://localhost:3012, choose **Send money** → **Bank Account** → Someone new → OPay, `8031234568`, ₦5,000 → **Continue** | The approval shows the account holder's name from the (simulated) bank lookup, the naira and the USDC it costs. **Approve** completes it, marked simulated |
| On the Send page choose **Crypto Wallet**, pick **Stellar** or **Tron**, and paste an address | A typo is caught by that network's checksum; Tron shows that the receiver gets USDT |
| Open the **Pay link page** URL the script printed | An invoice for ₦5,000 that anyone can pay in crypto from 15 networks, with no account |
| Run the `curl` above against `http://localhost:4012` | `402 Payment Required` with the NEAR payment offer |

The chat answers with a placeholder unless `ANTHROPIC_API_KEY` is set in `10kobo-backend/.env`. With a key, try
"send 5k to Mum", and the AI agent demo in `demo-agent/` (`./scripts/demo-agent.sh normal`, `wrong-name` or
`injection`), where an agent pays a supplier invoice, refuses a wrong account name, and ignores an invoice that tells
it to break its budget.

## Proof

Real payments on mainnet, all with small amounts:

| What | Result | Check it |
| --- | --- | --- |
| **AI agent pays a Nigerian bank with standard x402** (`exact` on `near:mainnet`, official client), 10 Nov | ₦1,400 to OPay in 2 min 28 s | [NEAR](https://nearblocks.io/txns/G83TN9VLfAPjiA6WogTSAhXVyB7SFFL2VrQe7GjjMZCC), [Base](https://basescan.org/tx/0x370b408edb9b23b64728113122532adc5573a7e665156f52618412664bb1a10b) |
| AI agent pays a Nigerian bank from NEAR, gas paid by the relayer, 5 Nov | ₦1,400 to OPay in 1 min 47 s | [NEAR](https://nearblocks.io/txns/5zbAweuUG3Z1rSJB5L47Gwsn4W8i2aG9y3LhQVKqkhBg), [Base](https://basescan.org/tx/0xc9c352d7fafb7b278afd5fb411e9d0aa7ae86263e862a81390f7ebdd80d9455e) |
| Invoice paid in naira, receiver gets USDC | ₦1,600 → 1.157 USDC in 3 min 23 s | [Base](https://basescan.org/tx/0xf2b4d29f36610e7d3ff6a1a6ae901c639d730fbeaa7b66c34201351ff57dc4b1) |
| Base to Stellar through NEAR Intents | 0.50 → 0.484 USDC in 40 s | [Base](https://basescan.org/tx/0x8ffaa37599f25ad76a8e89b404159863bdb6fbfe38e9bbe4b8019bfcceb71e11), [Stellar](https://stellar.expert/explorer/public/tx/771999fdadf6ee6a03811d5b019889f546770f2eee1975db4e28b2edc084129c) |
| Base to NEAR through NEAR Intents | 1.30 → 1.2999 USDC | [NEAR](https://nearblocks.io/txns/H7iHqyHC29T8mt2fW9m7j1kzbhexCS74eXZene6cyDUb) |
| USDC paid out to a bank account | ₦2,063 to OPay | [Base](https://basescan.org/tx/0x73e157a210415d3eefa2da21b608c15ec61da96eef8a2f599ef9b5dd101ef405) |

On 12 November, on the hosted site: a ₦2,000 naira deposit into a wallet, a ₦2,000 bank payment from the chat, and a
₦1,600 checkout at the demo shop paid in USDC through NEAR Intents, each reaching a real OPay account. More are on
https://10kobo.xyz/proof. The demo videos are on [@10koboPay](https://x.com/10koboPay).

## What is real, and what is not yet

- **Live on mainnet** since 11 November at https://10kobo.xyz, with real money and small limits.
- **Proven with real money:** bank payouts, naira deposits, naira in for invoices, AI agent payments from NEAR (with
  the relayer, and with standard x402), the shop checkout through NEAR Intents, and sends to Base, Arbitrum, NEAR and
  Stellar.
- **Priced with NEAR Intents but not yet sent with real money:** Tron, TON, Ethereum, Polygon, Optimism, Avalanche,
  Sui, Aptos, Gnosis, Monad and BNB Chain (which NEAR Intents limits to $1,000 and above for now). Deposits from
  Stellar are not offered, because NEAR Intents does not quote from Stellar yet.
- **Standard x402 `exact`** is on NEAR. Base and the other networks use the `near-intents` draft method for now.
- **Limits while in pilot:** ₦50,000 per payment with no API key, ₦100,000 a day per wallet and per bank account,
  3 unpaid payments open per account, and a daily company cap. Checked in code, under a lock, before money moves.
- **A pilot, not audited.** Naira moves through a Nigerian payment partner. The bank alert names the partner's
  account as the sender.

## Run it for development

```
cp .env.example .env      # test sign-in and simulated payments; no keys needed
npm ci
npm run db:up             # PostgreSQL in Docker on port 54445
npm run db:migrate
npm run dev               # http://localhost:4010
```

Checks: `npm run typecheck`, `npm test` (unit) and `npm run test:e2e` (integration, needs `npm run db:up`). The web
app has its own unit and browser tests. GitHub Actions runs them, and a secret scan, on every push, and deploys to
Railway when they pass.

## How it is built

| Part | Folder |
| --- | --- |
| Agent API, x402, pay links, payment links, invoices and merchant keys | `src/agent-api` |
| NEAR Intents client and the supported networks | `src/agent-api/cross-chain.ts`, `src/chain/usdc-chains.ts` |
| x402 on NEAR: official facilitator, relayer and USDC checks | `src/agent-api/near-relay.ts` |
| Chat assistant (Claude) and its tools | `src/agent` |
| Payments, plans, deposits and the background worker | `src/payments`, `src/plans`, `src/deposits` |
| Naira payouts and deposits through the payment partner | `src/providers/switch` |
| Limits, pause switches, audit log and the back office API | `src/ops` |
| An x402 agent using only the official client | `examples/x402-agent/` |
| Demo AI agent that pays invoices inside a budget | `demo-agent/` |
| MCP server, so Claude and other MCP clients can price and set up payments | `mcp-server/` |

Every outside service sits behind one abstract class (`IdentityProvider`, `CrossChain`, `PaymentProvider`,
`NairaOnramp` and others), and test mode swaps in simulated ones.

## Disclosure

- **Built in the window.** Both repositories start on 2 November 2026, after the hackathon was announced on
  19 October. The first version, from 2 to 4 November, paid Nigerian banks from a Base wallet. Everything built for
  NEAR comes after the `base-before-near` tag:
  [backend](https://github.com/blockfuselabs/10kobo-backend/compare/base-before-near...main) and
  [frontend](https://github.com/blockfuselabs/10kobo-frontend/compare/base-before-near...main).
- **Earlier code.** Some code for the payment partner, naira amounts and the web app's wallet setup was adapted from
  Tokkenly, Blockfuse Labs' own earlier product. No keys, data, users or history were copied. The files say where.
- **AI-written code.** Most of the code in both repositories was written with **Claude Code** (Anthropic), directed,
  tested and reviewed by the team. The chat assistant inside the app uses Claude.
- **Libraries.** Backend: NestJS, Fastify, Drizzle ORM, PostgreSQL, Zod, viem, near-api-js, borsh, jose, the
  official x402 packages (`@x402/core`, `@x402/near`, `@x402/fetch`), the MCP SDK and the Anthropic SDK. Web app:
  Next.js, React, Tailwind CSS, Privy, viem and permissionless. Tests: Jest, Vitest and Playwright.
- **Partners.** NEAR Intents for cross-chain settlement, Switch for naira, Base for user wallets, Privy for sign-in,
  Coinbase for gas sponsorship and Railway for hosting.

## License

MIT. See [LICENSE](LICENSE).
