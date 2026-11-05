#!/usr/bin/env bash
# REAL MONEY. The AI agent pays a Nigerian bank account over x402, with no API key, from NEAR, with no gas.
# Reads only the settings it names from .env.mainnet. Usage: scripts/demo-agent-real.sh SUPPLIER BANK ACCOUNT NAIRA
set -u
cd "$(dirname "$0")/.."
BACKEND="$PWD"
[ $# -eq 4 ] || { echo "Usage: $0 'Account holder name' OPay 0123456789 1400"; exit 1; }
curl -sf -o /dev/null http://localhost:4010/health || { echo 'The live backend is not running.'; exit 1; }
cd demo-agent
env -u TENKOBO_API_KEY AGENT_ENV_FILE=../.env.mainnet TENKOBO_API_URL=http://localhost:4010 \
  INVOICE_SUPPLIER="$1" INVOICE_BANK="$2" INVOICE_ACCOUNT="$3" INVOICE_NAIRA="$4" ALLOWED_ACCOUNTS="$3" BUDGET_USDC="${BUDGET_USDC:-2}" \
  NODE_OPTIONS="--require $BACKEND/scripts/local-dns.cjs" npm run -s demo -- invoices/normal.txt --x402 --real --gasless
