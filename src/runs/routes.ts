import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { runAgent, type Planner } from '../agent/runtime.js';
import { isTerminal, LocalRunRegistry, type RunStore } from './store.js';
import { SseStream, parseLastEventId } from './sse.js';

const createRunBody = z.object({
  goal: z.string().trim().min(1).max(2_000),
});

/**
 * Express 5 widens route params to `string | string[] | undefined`. Narrow once
 * here rather than casting at every call site.
 */
function routeParam(req: Request, name: string): string | null {
  const value = req.params[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `newPlanner` is a factory rather than an instance: each run gets its own, so
 * per-run planner state can never leak between concurrent runs.
 */
export function createRunsRouter(store: RunStore, newPlanner: () => Planner): Router {
  const router = Router();
  const registry = new LocalRunRegistry();

  // Cancellation is broadcast to every process; this one acts only on runs it
  // is actually executing and ignores the rest.
  store.onCancelRequest((runId, reason) => {
    registry.abort(runId, reason);
  });

  router.post('/runs', async (req: Request, res: Response) => {
    const parsed = createRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
      return;
    }

    const rawKey = req.header('Idempotency-Key');
    const idempotencyKey = rawKey && rawKey.trim().length > 0 ? rawKey.trim() : null;

    const { run, replayed } = await store.create(parsed.data.goal, idempotencyKey);

    // A retried POST returns the original run instead of starting a second one.
    if (replayed) {
      res.status(200).json({ run, idempotentReplay: true });
      return;
    }

    const signal = registry.register(run.id);
    res.status(202).json({ run, events: `/api/runs/${run.id}/events` });

    // Fire-and-forget: the response is already sent, progress arrives over SSE.
    void runAgent(run.goal, newPlanner(), signal, (payload) => {
      void store.append(run.id, payload);
    }).finally(() => registry.release(run.id));
  });

  router.get('/runs', async (_req: Request, res: Response) => {
    res.json({ runs: await store.list() });
  });

  router.get('/runs/:id', async (req: Request, res: Response) => {
    const runId = routeParam(req, 'id');
    const run = runId ? await store.get(runId) : undefined;
    if (!runId || !run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json({ run });
  });

  router.get('/runs/:id/events', async (req: Request, res: Response) => {
    const runId = routeParam(req, 'id');
    const run = runId ? await store.get(runId) : undefined;
    if (!runId || !run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }

    const afterSeq = parseLastEventId(req.header('Last-Event-ID'), req.query.lastEventId);
    const stream = new SseStream(res);

    // Subscribe before replaying, then drop anything the replay already covered.
    // Subscribing after the replay would lose events emitted in between.
    const seen = new Set<number>();
    const unsubscribe = await store.subscribe(runId, (event) => {
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      stream.send(event);
      if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
      ) {
        queueMicrotask(() => stream.close());
      }
    });

    res.on('close', unsubscribe);
    if (stream.closed) {
      unsubscribe();
      return;
    }

    for (const event of await store.readFrom(runId, afterSeq)) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      stream.send(event);
    }

    // Replaying a finished run is the same code path with nothing left to stream.
    const current = await store.get(runId);
    if (current && isTerminal(current.status)) queueMicrotask(() => stream.close());
  });

  router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
    const runId = routeParam(req, 'id');
    const run = runId ? await store.get(runId) : undefined;
    if (!runId || !run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (isTerminal(run.status)) {
      res.status(409).json({ error: 'run_already_terminal', status: run.status });
      return;
    }
    await store.requestCancel(runId, 'cancelled by client');
    res.status(202).json({ run: await store.get(runId) });
  });

  return router;
}
