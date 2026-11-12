#!/usr/bin/env bash
# Runs the demo agent with its NEAR key taken from .env.mainnet, without printing it.
#   ./run.sh preview|pay <bank> <account number> [naira]
set -euo pipefail
cd "$(dirname "$0")"
[ $# -ge 3 ] || { echo "Use: ./run.sh preview|pay <bank> <account number> [naira]"; exit 1; }
PAY_BANK="$2" PAY_ACCOUNT="$3" PAY_NAIRA="${4:-1400}" exec node --dns-result-order=ipv4first --env-file=../../.env.mainnet pay.mjs "$1"
