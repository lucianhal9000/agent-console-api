#!/usr/bin/env bash
# Drives a run through the LLM planner against the mock model server, so the
# JSON-mode plan parsing, tool-call argument handling, and SSE delta parsing are
# all exercised without an API key or a network call.
set -euo pipefail

PORT="${PORT:-4020}"
MOCK_PORT="${MOCK_LLM_PORT:-5555}"
BASE="localhost:${PORT}"

node scripts/mock-llm.mjs &
MOCK=$!
node dist/server.js &
SERVER=$!
trap 'kill $SERVER $MOCK 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "$BASE/health" >/dev/null && break || sleep 1
done

HEALTH=$(curl -sf "$BASE/health")
echo "$HEALTH"
echo "$HEALTH" | grep -q '"planner":"mock-model"' || {
  echo "expected the LLM planner to be active"; exit 1;
}

ID=$(curl -sf -X POST "$BASE/api/runs" \
      -H 'Content-Type: application/json' \
      -d '{"goal":"what is 18% of 1200 plus 45, and what is the date today?"}' \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).run.id))")

timeout 60 curl -sN "$BASE/api/runs/$ID/events" > llm-stream.txt

grep -q 'event: plan.created'  llm-stream.txt
grep -q 'event: run.completed' llm-stream.txt

# The model chose the tool and its arguments; the tool really ran. 1200*0.18+45.
grep -q '"tool":"calculator"' llm-stream.txt || { echo "calculator was never called"; exit 1; }
grep -q '"value":261'        llm-stream.txt || { echo "calculator did not compute 261"; exit 1; }

# Narration must arrive as multiple deltas, not one blob — that is the only
# thing distinguishing real streaming from a buffered response.
DELTAS=$(grep -c 'event: token.delta' llm-stream.txt)
[ "$DELTAS" -gt 5 ] || { echo "expected streamed narration, got $DELTAS deltas"; exit 1; }

# A permanent failure must fail once, not three times. Retrying a bad
# expression or a 404 only makes the failure slower and noisier.
BAD_ID=$(curl -sf -X POST "$BASE/api/runs" \
          -H 'Content-Type: application/json' \
          -d '{"goal":"MOCK_PERMANENT_FAILURE evaluate something broken"}' \
          | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).run.id))")

timeout 60 curl -sN "$BASE/api/runs/$BAD_ID/events" > bad-stream.txt

grep -q 'event: run.failed' bad-stream.txt || { echo "expected the run to fail"; exit 1; }
grep -q '"retryable":false' bad-stream.txt || { echo "failure was not classified as permanent"; exit 1; }
grep -q 'was not retried'   bad-stream.txt || { echo "failure message should say it was not retried"; exit 1; }

ATTEMPTS=$(grep -c 'event: tool.call' bad-stream.txt)
[ "$ATTEMPTS" = "1" ] || { echo "expected exactly 1 attempt on a permanent error, got $ATTEMPTS"; exit 1; }

# Step numbering in the error must match what the console shows.
grep -q 'step 1 (calculator)' bad-stream.txt || { echo "step number in the error is wrong"; exit 1; }

echo "llm smoke passed: $(grep -c '^event:' llm-stream.txt) frames, $DELTAS narration deltas, permanent failure not retried"
