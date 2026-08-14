# agent-console-api

A streaming agent runtime in Node/TypeScript. Agents plan, call tools, and
report progress over Server-Sent Events, so a client can render what the agent
is doing *while* it does it — plan, per-step tool calls with their arguments,
failed attempts and retries, streamed narration, and the final answer.

Phase 1 (this repo, current state) is the runtime and transport with a scripted
planner in place of an LLM. That is deliberate: the orchestration and the wire
contract are the hard parts, and they are far easier to build and test when the
event stream is deterministic and costs nothing to run.

## Running it

```bash
npm install
npm run dev            # http://localhost:4000
```

```bash
# start a run
curl -X POST localhost:4000/api/runs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-key-1' \
  -d '{"goal":"compare two vendors on price"}'

# watch it
curl -N localhost:4000/api/runs/<id>/events

# resume after a dropped connection
curl -N -H 'Last-Event-ID: 42' localhost:4000/api/runs/<id>/events

# stop it
curl -X POST localhost:4000/api/runs/<id>/cancel
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/runs` | `202` with the run. Honours `Idempotency-Key`; a repeat returns `200` with the original run and `idempotentReplay: true`. |
| `GET` | `/api/runs` | All runs, newest first. |
| `GET` | `/api/runs/:id` | One run. |
| `GET` | `/api/runs/:id/events` | SSE. Accepts `Last-Event-ID` (or `?lastEventId=`). |
| `POST` | `/api/runs/:id/cancel` | `202` accepted; `409` if already terminal. |
| `GET` | `/health` | Liveness. |

## Design decisions

**Every event carries a monotonic `seq`, emitted as the SSE `id:` field.**
That single choice buys three features at once. A client that drops mid-run
reconnects with `Last-Event-ID` and gets an exact replay of what it missed.
Viewing a finished run is the same code path with nothing left to stream, so
replay is free. And the seq is a natural dedupe key when a replay and a live
subscription overlap.

**Resilience lives in the runtime, not the planner.** `runtime.ts` owns
per-attempt timeouts, bounded retries with exponential backoff and full jitter,
a step cap, and cooperative cancellation through one `AbortSignal`. The planner
just plans, executes, and narrates. Swapping the scripted planner for an LLM one
touches no orchestration code.

**A failed attempt is a first-class event, not a swallowed detail.** Every
`tool.call` emits a matching `tool.result` with `ok: false` and the error when it
fails, and the next attempt emits a new `tool.call` with an incremented
`attempt`. A user watching a run sees the agent stumble and recover, which is
most of what "trusting an agent" actually requires. A step that exhausts its
retries fails the run rather than quietly producing a partial answer.

**Backpressure is handled explicitly.** When `res.write()` signals a full socket
buffer, the stream buffers; past a soft limit it coalesces consecutive
`token.delta` frames for the same step (the text still arrives, in fewer
frames); past a hard limit it closes the connection, and the client reconnects
with `Last-Event-ID`. An unbounded per-client queue is how a few backgrounded
browser tabs turn into an out-of-memory kill.

**The store interface is deliberately narrow** — `append`, `readFrom`,
`subscribe`. Phase 1 backs it with a `Map`; moving to Redis Streams touches only
`store.ts`.

## Known limitations

- In-memory store. Runs and transcripts are lost on restart, and it will not
  survive more than one process.
- The planner is scripted. No LLM, no real tools.
- Idempotency keys never expire and are not scoped to a caller.
- CORS is open by default.
- No auth.
- No human-in-the-loop approval gate yet.

## Roadmap

1. ~~SSE transport, event contract, orchestration, cancellation, idempotency~~ ✅
2. Real LLM planner behind the existing `Planner` interface — tool/function
   calling, ReAct loop, token streaming from the model
3. Redis-backed store: durable transcripts, resume across restarts, multi-process
4. Human-in-the-loop — an approval gate that pauses a run at `awaiting_approval`
   and resumes on `POST /runs/:id/approve`
5. Next.js console: live timeline, collapsible tool args and results, cancel,
   approve, replay a past run
6. Eval harness — a task set with assertions over the event transcript, run in CI

## Stack

Node 22, Express 5, TypeScript (strict), Zod. No framework for the agent loop —
the orchestration is the point.
