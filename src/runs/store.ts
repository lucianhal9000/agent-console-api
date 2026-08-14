import { randomUUID } from 'node:crypto';
import {
  TERMINAL_EVENTS,
  type AgentEvent,
  type AgentEventPayload,
  type Run,
  type RunStatus,
} from '../types/events.js';

/**
 * Phase 1 store: in-memory. The interface is deliberately narrow (append,
 * readFrom, subscribe) so that swapping in Redis Streams later touches only
 * this file — the routes and the agent runtime never see the backing store.
 */

export type Subscriber = (event: AgentEvent) => void;

interface RunRecord {
  run: Run;
  events: AgentEvent[];
  subscribers: Set<Subscriber>;
  abort: AbortController;
}

const MAX_EVENTS_PER_RUN = 5_000;

export class RunStore {
  #runs = new Map<string, RunRecord>();
  #byIdempotencyKey = new Map<string, string>();

  create(goal: string, idempotencyKey: string | null): { run: Run; replayed: boolean } {
    if (idempotencyKey) {
      const existing = this.#byIdempotencyKey.get(idempotencyKey);
      if (existing) {
        const record = this.#runs.get(existing);
        if (record) return { run: record.run, replayed: true };
      }
    }

    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      goal,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      idempotencyKey,
    };

    this.#runs.set(run.id, {
      run,
      events: [],
      subscribers: new Set(),
      abort: new AbortController(),
    });

    if (idempotencyKey) this.#byIdempotencyKey.set(idempotencyKey, run.id);
    return { run, replayed: false };
  }

  get(runId: string): Run | undefined {
    return this.#runs.get(runId)?.run;
  }

  list(): Run[] {
    return [...this.#runs.values()]
      .map((r) => r.run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  signal(runId: string): AbortSignal | undefined {
    return this.#runs.get(runId)?.abort.signal;
  }

  cancel(runId: string, reason: string): boolean {
    const record = this.#runs.get(runId);
    if (!record) return false;
    if (isTerminal(record.run.status)) return false;
    record.abort.abort(new Error(reason));
    return true;
  }

  setStatus(runId: string, status: RunStatus): void {
    const record = this.#runs.get(runId);
    if (!record) return;
    record.run.status = status;
    record.run.updatedAt = new Date().toISOString();
  }

  /** Append an event, stamp it with the next seq, and fan it out. */
  append(runId: string, payload: AgentEventPayload): AgentEvent | undefined {
    const record = this.#runs.get(runId);
    if (!record) return undefined;

    const last = record.events.at(-1);
    const event: AgentEvent = {
      ...payload,
      seq: (last?.seq ?? 0) + 1,
      runId,
      ts: new Date().toISOString(),
    };

    // Heartbeats keep the connection warm but must not grow the transcript,
    // or a long idle run would replay thousands of empty frames.
    if (payload.type !== 'heartbeat') {
      record.events.push(event);
      if (record.events.length > MAX_EVENTS_PER_RUN) record.events.shift();
    }

    if (TERMINAL_EVENTS.has(payload.type)) {
      record.run.status =
        payload.type === 'run.completed'
          ? 'succeeded'
          : payload.type === 'run.failed'
            ? 'failed'
            : 'cancelled';
      record.run.updatedAt = event.ts;
    }

    for (const subscriber of record.subscribers) {
      try {
        subscriber(event);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
    return event;
  }

  /** Every persisted event strictly after `afterSeq`. */
  readFrom(runId: string, afterSeq: number): AgentEvent[] {
    const record = this.#runs.get(runId);
    if (!record) return [];
    return record.events.filter((e) => e.seq > afterSeq);
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const record = this.#runs.get(runId);
    if (!record) return () => {};
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export const store = new RunStore();
