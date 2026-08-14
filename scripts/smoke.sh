#!/usr/bin/env bash
# Starts the built server, drives one real agent run, and asserts the stream
# contains what it should. Used by CI against both store backends.
set -euo pipefail

PORT="${PORT:-4000}"
BASE="localhost:${PORT}"

node dist/server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "$BASE/health" >/dev/null && break || sleep 1
done
curl -sf "$BASE/health"
echo

ID=$(curl -sf -X POST "$BASE/api/runs" \
      -H 'Content-Type: application/json' \
      -H 'Idempotency-Key: smoke-1' \
      -d '{"goal":"ci smoke test"}' \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).run.id))")

# The same key must not start a second run.
REPLAY=$(curl -sf -X POST "$BASE/api/runs" \
          -H 'Content-Type: application/json' \
          -H 'Idempotency-Key: smoke-1' \
          -d '{"goal":"ci smoke test"}' \
          | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).run.id))")
[ "$ID" = "$REPLAY" ] || { echo "idempotency failed: $ID != $REPLAY"; exit 1; }

timeout 60 curl -sN "$BASE/api/runs/$ID/events" > stream.txt

grep -q 'event: run.started'   stream.txt
grep -q 'event: plan.created'  stream.txt
grep -q 'event: tool.call'     stream.txt
grep -q 'event: token.delta'   stream.txt
grep -q 'event: run.completed' stream.txt

# The flaky tool must fail twice and then succeed — proving retries are real
# and that failed attempts are reported rather than swallowed.
FAILED=$(grep '"tool":"flaky_calculator"' stream.txt | grep -c '"ok":false')
[ "$FAILED" = "2" ] || { echo "expected 2 failed attempts, got $FAILED"; exit 1; }

# Cancelling a finished run is a conflict, not a success.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/runs/$ID/cancel")
[ "$CODE" = "409" ] || { echo "expected 409 on terminal run, got $CODE"; exit 1; }

echo "smoke passed: $(grep -c '^event:' stream.txt) frames"
