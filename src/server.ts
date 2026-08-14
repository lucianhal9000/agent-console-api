import 'dotenv/config';
import express from 'express';
import { createRunsRouter } from './runs/routes.js';
import { MemoryRunStore } from './runs/memory-store.js';
import { RedisRunStore } from './runs/redis-store.js';
import type { RunStore } from './runs/store.js';

async function createStore(): Promise<{ store: RunStore; backend: string }> {
  const url = process.env.REDIS_URL;
  if (!url) {
    // No Redis configured: run single-process with in-memory state. Keeps the
    // app runnable with zero external dependencies.
    return { store: new MemoryRunStore(), backend: 'memory' };
  }

  const store = new RedisRunStore({ url });
  await store.ready();
  return { store, backend: 'redis' };
}

async function main(): Promise<void> {
  const { store, backend } = await createStore();
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // Permissive for local development; tighten to the deployed frontend origin
  // before this goes anywhere real.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Idempotency-Key, Last-Event-ID',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', backend, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use('/api', createRunsRouter(store));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const port = Number(process.env.PORT ?? 4000);
  const server = app.listen(port, () => {
    console.log(`agent-console-api listening on http://localhost:${port} (store: ${backend})`);
  });

  // SSE connections are long-lived, so an unbounded graceful shutdown would
  // hang forever. Give clients a moment, then force the process down.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down`);
      server.close(() => {
        void store.close().finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 5_000).unref();
    });
  }
}

main().catch((error: unknown) => {
  console.error('failed to start:', error);
  process.exit(1);
});
