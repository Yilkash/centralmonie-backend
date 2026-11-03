#!/usr/bin/env bash
# Starts the backend on real money, from .env.mainnet. Run from the backend folder.
set -euo pipefail
export NODE_OPTIONS="--require $PWD/scripts/local-dns.cjs"
export DOTENV_CONFIG_PATH=.env.mainnet
exec node -r dotenv/config dist/main
