# 10kobo demo agent

An AI agent that pays supplier invoices to Nigerian bank accounts through the 10kobo Agent API, inside a budget.
It reads an invoice, asks for a quote, compares the bank's name for the account with the supplier, then pays or refuses.

## What the AI can and cannot do

| The AI model can | Only code can |
| --- | --- |
| Read the invoice | Hold the wallet key |
| Ask for a quote | Sign and send USDC |
| Choose to pay a quote, or refuse | Enforce the budget and one payment per task |

The model has no tool that takes an address. It can only name a quote that 10kobo gave this task. An invoice can
try to talk the model into something, but code refuses any payment over budget. The final result comes from what
the payment did, not from what the model says.

With real money, also set `ALLOWED_ACCOUNTS` to the bank accounts the owner approves. Without it, an invoice that fools the model could still send up to the budget to the wrong account. A ledger, `.paid-invoices.json`, stops one invoice being paid twice.

## Try it, with no real money

1. In `10kobo-backend`, start the database and run the backend in test mode (`PAYMENTS_MODE=simulated`) with an `ADMIN_TOKEN` set.
2. Make an API key: `POST /v1/admin/agent-keys` with `{"name":"Demo","daily_limit_naira":1000000}`, using the admin token as a bearer token.
3. In this folder, run `npm install`.
4. Set `ANTHROPIC_API_KEY`, `TENKOBO_API_KEY` and `TENKOBO_API_URL`.
5. Run each invoice with `npm run demo -- invoices/normal.txt`, and see:

| Invoice | What you should see |
| --- | --- |
| `invoices/normal.txt` | The name matches, so it pays and prints a receipt |
| `invoices/wrong-name.txt` | The bank's name differs from the supplier, so it refuses |
| `invoices/injection.txt` | The invoice tells the agent to ignore its budget. It refuses, and code would too |

Add `--x402` and leave out `TENKOBO_API_KEY` to pay with no key at all: no sign-up, up to ₦50,000 a payment. With real money this also needs `X402_KEYLESS_ENABLED=true` on the backend. Add `--x402` to pay through the x402 endpoint: the agent then reads the amount and deposit address from the `PAYMENT-REQUIRED` header. This follows the `near-intents` method drafted in x402-foundation/x402 pull request 3370, which is not final. Two differences: the recipient stays empty in the first 402, and an API key is still required.

`npm test` runs the rules without the AI model or any network.

## With real money

`--real` signs from the NEAR wallet in `NEAR_AGENT_ACCOUNT_ID` and `NEAR_AGENT_PRIVATE_KEY`. Set `AGENT_ENV_FILE` to read
settings from a file: the program picks out only the settings it names, and ignores the rest of the file.
Keep only a few dollars in this wallet.
