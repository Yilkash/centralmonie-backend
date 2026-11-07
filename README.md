# 10kobo

**Naira and stablecoins, both ways.** 10kobo lets people, businesses and AI agents pay any Nigerian bank account
from stablecoins on 16 blockchains, and get paid in naira or USDC. Cross-chain movement goes through
**NEAR Intents**, and it runs on mainnet with real money.

This repository is the backend (NestJS API). The web app is in
[blockfuselabs/10kobo-frontend](https://github.com/blockfuselabs/10kobo-frontend). Built at NEAR HACKATHON
(November 2026). Tracks: Real-World Money, Agent Economy.

## The problem

Nigerians increasingly earn and hold USDC, and AI agents increasingly hold crypto, but rent, suppliers, school fees
and electricity are paid in naira to a bank account. Getting from one to the other today means a P2P trader, a
spread, a delay and someone to trust. Going the other way, a client abroad or a customer with only naira cannot
easily pay someone who wants USDC. An AI agent cannot pay a Nigerian bank account at all.

## What it does

| Who | What they can do |
| --- | --- |
| A person | Pay any Nigerian bank, buy airtime and data, and send USDC or USDT to 16 networks, by chat or on the Send page. Deposit by naira bank transfer, or from 14 other networks |
| A business | Send invoices its clients pay by naira bank transfer or crypto from 15 networks, and receive naira in a bank or USDC. Add a checkout button to a website. Get signed notices when an order is paid |
| An AI agent | Pay a Nigerian bank account with one API call or over x402, with no sign-up. It sees the account holder's name before paying, and can pay from NEAR with no gas |

10kobo never holds the money in between: a payment goes from the payer's wallet through NEAR Intents and the
payment partner to the bank, or arrives at the receiver's own wallet.

## What NEAR does

| NEAR piece | Where 10kobo uses it | Code |
| --- | --- | --- |
| **NEAR Intents (1Click API)** | Every move between chains: paying an invoice or a bank from 15 networks, sending to 16 networks, and deposits from 14. Bank payments use exact-output quotes, so the bank receives the exact naira asked for | `src/agent-api/cross-chain.ts` |
| **NEAR accounts** | Agents pay from NEAR; invoices and sends can deliver USDC to a `name.near` account; the prize account is `10kobo.near` | `src/chain/usdc-chains.ts` |
| **Meta transactions (relayer)** | An agent paying from NEAR signs a delegate action and 10kobo's relayer pays the gas, so the agent needs only USDC. The relayer pays only for a USDC transfer to that payment's own deposit address | `src/agent-api/near-relay.ts` |
| **x402 with the `near-intents` method** | Agents pay with no API key: the first call answers `402 Payment Required` with a NEAR Intents payment, following the draft in x402-foundation/x402 pull request 3370 (not final) | `src/agent-api/x402.ts` |

## Try it in about 10 minutes, with no keys and no real money

Needs Node 22, Docker and Git. The test copy uses its own database and moves no money: sign-in is a test login,
bank and airtime payouts are simulated, and every simulated result is labelled as such.

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
| Open the **Pay link page** URL the script printed | An invoice for ₦5,000 to a bank account that anyone can pay in crypto from 15 networks, with no account. Pick a network and enter a refund address to see the exact amount and a one-time address |
| Open http://localhost:3012/proof | Real mainnet payments, each with links to its block explorer (see "Proof" below) |
| Run the request below | `402 Payment Required`, with a NEAR Intents payment for the agent in the `PAYMENT-REQUIRED` header |

```
curl -i -X POST http://localhost:4012/v1/agent/x402/pay -H 'content-type: application/json' -d '{
  "amount_naira": 5000, "bank_name": "OPay", "account_number": "8031234568", "pay_from": "near",
  "refund_to": "agent.near", "payer_name": "Judge", "payer_email": "judge@example.com", "purpose": "Invoice 1042"
}'
```

The chat answers with a placeholder unless `ANTHROPIC_API_KEY` is set in `10kobo-backend/.env`. With a key, try
"send 5k to Mum", and the AI agent demo in `demo-agent/` (`./scripts/demo-agent.sh normal`, `wrong-name` or
`injection`), where an agent pays a supplier invoice, refuses a wrong account name, and ignores an invoice that tells
it to break its budget.

## Proof

Real payments on mainnet from 3 to 6 November 2026, all with small amounts:

| What | Result | Check it |
| --- | --- | --- |
| AI agent pays a Nigerian bank from NEAR, gas paid by the relayer | ₦1,400 to OPay in 1 min 47 s | [NEAR](https://nearblocks.io/txns/5zbAweuUG3Z1rSJB5L47Gwsn4W8i2aG9y3LhQVKqkhBg), [Base](https://basescan.org/tx/0xc9c352d7fafb7b278afd5fb411e9d0aa7ae86263e862a81390f7ebdd80d9455e) |
| Invoice paid in naira, receiver gets USDC | ₦1,600 → 1.157 USDC in 3 min 23 s | [Base](https://basescan.org/tx/0xf2b4d29f36610e7d3ff6a1a6ae901c639d730fbeaa7b66c34201351ff57dc4b1) |
| Base to Stellar through NEAR Intents | 0.50 → 0.484 USDC in 40 s | [Base](https://basescan.org/tx/0x8ffaa37599f25ad76a8e89b404159863bdb6fbfe38e9bbe4b8019bfcceb71e11), [Stellar](https://stellar.expert/explorer/public/tx/771999fdadf6ee6a03811d5b019889f546770f2eee1975db4e28b2edc084129c) |
| Base to NEAR through NEAR Intents | 1.30 → 1.2999 USDC | [NEAR](https://nearblocks.io/txns/H7iHqyHC29T8mt2fW9m7j1kzbhexCS74eXZene6cyDUb) |
| USDC paid out to a bank account | ₦2,063 to OPay | [Base](https://basescan.org/tx/0x73e157a210415d3eefa2da21b608c15ec61da96eef8a2f599ef9b5dd101ef405) |

The full list of 24 is on the `/proof` page of the web app.

## What is real, and what is not yet

- Proven with real money: bank payouts, naira deposits, naira in for invoices, AI agent payments from NEAR with the
  relayer, and sends to Base, Arbitrum, NEAR and Stellar.
- Priced with NEAR Intents but not yet sent with real money: Tron, TON, Ethereum, Polygon, Optimism, Avalanche, Sui,
  Aptos, Gnosis, Monad and BNB Chain (which NEAR Intents limits to $1,000 and above for now). Deposits from Stellar
  are not offered, because NEAR Intents does not quote from Stellar yet.
- Limits while in pilot: ₦50,000 per payment with no API key, and daily caps per wallet, per account and in total.
- A pilot, not audited. Naira moves through a Nigerian payment partner.

## Run it for development

```
cp .env.example .env      # test sign-in and simulated payments; no keys needed
npm ci
npm run db:up             # PostgreSQL in Docker on port 54445
npm run db:migrate
npm run dev               # http://localhost:4010
```

Checks: `npm run typecheck`, `npm test` (unit) and `npm run test:e2e` (integration, needs `npm run db:up`). The web
app has its own unit and browser tests. GitHub Actions runs them, and a secret scan, on every push.

## How it is built

| Part | Folder |
| --- | --- |
| Agent API, pay links, invoices, checkout and x402 | `src/agent-api` |
| NEAR Intents client and the supported networks | `src/agent-api/cross-chain.ts`, `src/chain/usdc-chains.ts` |
| Chat assistant (Claude) and its tools | `src/agent` |
| Payments, plans, deposits and the background worker | `src/payments`, `src/plans`, `src/deposits` |
| Naira payouts and deposits through the payment partner | `src/providers/switch` |
| Demo AI agent that pays invoices | `demo-agent/` |
| MCP server, so Claude and other MCP clients can pay | `mcp-server/` |

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
- **AI.** Most of the code was written with Claude Code (Anthropic), directed and reviewed by the team. The chat
  assistant uses Claude.
- **Libraries.** Backend: NestJS, Fastify, Drizzle ORM, PostgreSQL, Zod, viem, near-api-js, borsh, jose and the
  Anthropic SDK. Web app: Next.js, React, Tailwind CSS, Privy, viem and permissionless. Tests: Jest, Vitest and
  Playwright.
- **Partners.** NEAR Intents for cross-chain settlement, Switch for naira, Base for user wallets and Privy for
  sign-in.
