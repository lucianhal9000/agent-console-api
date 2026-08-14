import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ScriptedPlanner } from '../agent/scripted-planner.js';
import { runAgent } from '../agent/runtime.js';
import { isTerminal, store } from './store.js';
import { SseStream, parseLastEventId } from './sse.js';

const createRunBody = z.object({
  goal: z.string().trim().min(1).max(2_000),
});

export const runsRouter = Router();

/**
 * Express 5 widens route params to `string | string[] | undefined`. Narrow once
 * here rather than casting at every call site.
 */
function routeParam(req: Request, name: string): string | null {
  const value = req.params[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

runsRouter.post('/runs', (req: Request, res: Response) => {
  const parsed = createRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  const rawKey = req.header('Idempotency-Key');
  const idempotencyKey = rawKey && rawKey.trim().length > 0 ? rawKey.trim() : null;

  const { run, replayed } = store.create(parsed.data.goal, idempotencyKey);

  // A retried POST returns the original run instead of starting a second one.
  if (replayed) {
    res.status(200).json({ run, idempotentReplay: true });
    return;
  }

  const signal = store.signal(run.id);
  if (!signal) {
    res.status(500).json({ error: 'run_not_initialised' });
    return;
  }

  store.setStatus(run.id, 'running');
  res.status(202).json({
    run,
    events: `/api/runs/${run.id}/events`,
  });

  // Fire-and-forget: the response is already sent, progress arrives over SSE.
  void runAgent(run.goal, new ScriptedPlanner(), signal, (payload) => {
    store.append(run.id, payload);
  });
});

runsRouter.get('/runs', (_req: Request, res: Response) => {
  res.json({ runs: store.list() });
});

runsRouter.get('/runs/:id', (req: Request, res: Response) => {
  const runId = routeParam(req, 'id');
  const run = runId ? store.get(runId) : undefined;
  if (!runId || !run) {
    res.status(404).json({ error: 'run_not_found' });
    return;
  }
  res.json({ run });
});

runsRouter.get('/runs/:id/events', (req: Request, res: Response) => {
  const runId = routeParam(req, 'id');
  const run = runId ? store.get(runId) : undefined;
  if (!runId || !run) {
    res.status(404).json({ error: 'run_not_found' });
    return;
  }

  const afterSeq = parseLastEventId(req.header('Last-Event-ID'), req.query.lastEventId);
  const stream = new SseStream(res);

  // Subscribe before replaying, then drop anything the replay already covered.
  // Subscribing after the replay would lose events emitted in between.
  const seen = new Set<number>();
  const unsubscribe = store.subscribe(runId, (event) => {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    stream.send(event);
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      queueMicrotask(() => stream.close());
    }
  });

  for (const event of store.readFrom(runId, afterSeq)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    stream.send(event);
  }

  // Replaying a finished run is the same code path with nothing left to stream.
  const current = store.get(runId);
  if (current && isTerminal(current.status)) queueMicrotask(() => stream.close());

  res.on('close', unsubscribe);
});

runsRouter.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const runId = routeParam(req, 'id');
  const run = runId ? store.get(runId) : undefined;
  if (!runId || !run) {
    res.status(404).json({ error: 'run_not_found' });
    return;
  }
  if (isTerminal(run.status)) {
    res.status(409).json({ error: 'run_already_terminal', status: run.status });
    return;
  }
  store.cancel(runId, 'cancelled by client');
  res.status(202).json({ run: store.get(runId) });
});
