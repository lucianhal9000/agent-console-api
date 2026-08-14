# agent-console

A streaming agent runtime in Node/TypeScript, plus a console that makes a run
legible while it happens. Agents plan, call tools, and
report progress over Server-Sent Events, so a client can render what the agent
is doing *while* it does it — plan, per-step tool calls with their arguments,
failed attempts and retries, streamed narration, and the final answer.

The planner is currently scripted rather than LLM-backed. That is deliberate:
the orchestration and the wire contract are the hard parts, and they are far
easier to build and test when the event stream is deterministic and costs
nothing to run. Swapping in an LLM planner touches one file.

## The console

`web/` is a Next.js app that renders a run as it happens: the plan, each step,
every tool call with its arguments, failed attempts alongside the retry that
recovered, and narration streaming in token by token.

```bash
cd web && npm install && npm run dev     # http://localhost:3000
```

It proxies `/api` to the backend, so there is one origin and no CORS preflight
on the event stream. Two details worth knowing:

The reconnect cursor is free. `EventSource` remembers the last `id:` it received
and sends it back as `Last-Event-ID` without being asked, so closing the tab
mid-run and reopening it resumes exactly where it left off — no client code.

Rendering is a pure fold over the event list, so a replayed run produces a
byte-identical view to one watched live. There is no separate replay mode.

## Running the API

```bash
npm install
npm run dev            # http://localhost:4000
```

With no `REDIS_URL` set the app runs entirely in memory — no external
dependency. Set `REDIS_URL` and it switches to the durable store; `/health`
reports which backend is live.

```bash
docker compose up -d redis          # or point REDIS_URL at a hosted instance
REDIS_URL=redis://localhost:6379 npm run dev
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
| `GET` | `/health` | Liveness, plus which store backend is active. |

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

**Two stores behind one narrow interface** — `append`, `readFrom`, `subscribe`,
`requestCancel`. The in-memory implementation keeps the app runnable with no
dependencies; the Redis one adds durability and multi-process fan-out. Routes
and runtime never learn which is in use.

**Redis layout.** The transcript is a Redis Stream (`run:{id}:events`), the seq
is an `INCR` counter, and live fan-out is pub/sub on `agent:events:{id}`. One
Lua script does the counter bump, the append, the publish, and the TTL refresh
atomically — without it, a crash between the `INCR` and the `XADD` would burn a
seq and leave a permanent hole in a client's replay. Everything carries a TTL so
abandoned transcripts expire instead of accumulating.

**Cancellation is a broadcast, not a method call.** The instance handling
`POST /cancel` is often not the one running the agent. Cancel publishes to a
control channel that every instance hears; each checks its local registry of
`AbortController`s and only the owner acts. Verified in CI-adjacent testing by
cancelling a run on instance A through instance B.

## Known limitations

- The planner is scripted. No LLM, no real tools.
- `readFrom` scans the whole stream and filters by seq rather than seeking to a
  position. Fine at the 5k-event cap, wrong at a much larger one.
- Idempotency keys are global rather than scoped to a caller, so two callers
  could collide on the same key.
- The in-memory store is still single-process; it is the default, so running
  more than one instance without `REDIS_URL` will not behave as expected.
- CORS is open by default.
- No auth.
- No human-in-the-loop approval gate yet.

## Roadmap

1. ~~SSE transport, event contract, orchestration, cancellation, idempotency~~ ✅
2. ~~Redis-backed store: durable transcripts, resume across restarts,
   cross-process cancellation~~ ✅
3. Real LLM planner behind the existing `Planner` interface — tool/function
   calling, ReAct loop, token streaming from the model
4. Human-in-the-loop — an approval gate that pauses a run at `awaiting_approval`
   and resumes on `POST /runs/:id/approve`
5. Next.js console: live timeline, collapsible tool args and results, cancel,
   approve, replay a past run
6. Eval harness — a task set with assertions over the event transcript, run in CI

## Stack

Node 22, Express 5, TypeScript (strict), Zod, Redis (Streams + pub/sub) via
ioredis. No framework for the agent loop — the orchestration is the point.

CI runs the full smoke suite against both store backends, plus a durability
check that kills the server mid-life and asserts the transcript replays
identically from a fresh process.
