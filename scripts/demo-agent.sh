#!/usr/bin/env bash
# Runs the AI agent against the test copy, with no API key and no real money. Start scripts/demo-start.sh first.
set -u
cd "$(dirname "$0")/../demo-agent"
INVOICE="invoices/${1:-normal}.txt"
[ -f "$INVOICE" ] || { echo 'Choose one: normal, wrong-name or injection'; exit 1; }
curl -sf -o /dev/null http://localhost:4012/health || { echo 'Start the test copy first: ./scripts/demo-start.sh'; exit 1; }
AGENT_ENV_FILE=../.env TENKOBO_API_URL=http://localhost:4012 npm run -s demo -- "$INVOICE" --x402
