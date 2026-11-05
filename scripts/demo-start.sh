#!/usr/bin/env bash
# A separate test copy for presenting: pay link page, AI agent and MCP. No real money can move here.
# It uses its own database and ports (web 3012, API 4012), and does not touch the live app on 3010 and 4010.
set -u
cd "$(dirname "$0")/.."
BACKEND="$PWD"
FRONTEND="$PWD/../10kobo-frontend-work"; [ -d "$FRONTEND" ] || FRONTEND="$PWD/../10kobo-frontend"
export DATABASE_URL='postgres://tenkobo:localdev@localhost:54445/tenkobo_demo'
docker exec tenkobo-pg psql -U tenkobo -d postgres -tc "select 1 from pg_database where datname='tenkobo_demo'" | grep -q 1 || docker exec tenkobo-pg psql -U tenkobo -d postgres -qc 'CREATE DATABASE tenkobo_demo'
npm run -s db:migrate >/dev/null || { echo 'The database could not be prepared. Is Docker running?'; exit 1; }
PORT=4012 PAYMENTS_MODE=simulated IDENTITY_PROVIDER=test WORKER_ENABLED=true CORS_ORIGINS=http://localhost:3012 PUBLIC_APP_URL=http://localhost:3012 npx ts-node --transpile-only src/main.ts >/tmp/10kobo-demo-backend.log 2>&1 &
API=$!
(cd "$FRONTEND" && NEXT_DIST_DIR=.next-demo NEXT_PUBLIC_IDENTITY=test NEXT_PUBLIC_TEST_EMAIL=demo@10kobo.test NEXT_PUBLIC_TEST_WALLET=0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d NEXT_PUBLIC_API_URL=http://localhost:4012 exec npx next dev -p 3012 >/tmp/10kobo-demo-web.log 2>&1) &
WEB=$!
trap 'kill $API $WEB 2>/dev/null; fuser -k 4012/tcp 3012/tcp >/dev/null 2>&1' EXIT
for _ in $(seq 1 90); do curl -sf -o /dev/null http://localhost:4012/health && break; sleep 1; done
for _ in $(seq 1 120); do curl -sf -o /dev/null http://localhost:3012 && break; sleep 1; done
LINK=$(curl -s http://localhost:4012/v1/pay-links -H 'authorization: Bearer test|demo@10kobo.test|0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d' -H 'content-type: application/json' -d '{"amount_naira":5000,"bank_name":"OPay","account_number":"8031234568","note":"Generator repair"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('url','could not make a link'))")
cat <<EOM

  Test copy is ready. NO REAL MONEY moves here.

  Pay link page:  $LINK
  Test web app:   http://localhost:3012
  AI agent:       ./scripts/demo-agent.sh normal
                  ./scripts/demo-agent.sh wrong-name
                  ./scripts/demo-agent.sh injection

  Live app is unchanged on http://localhost:3010. Press Ctrl+C to stop this copy.

EOM
wait
