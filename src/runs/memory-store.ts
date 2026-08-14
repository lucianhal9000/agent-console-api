import { randomUUID } from 'node:crypto';
import {
  TERMINAL_EVENTS,
  type AgentEvent,
  type AgentEventPayload,
  type Run,
} from '../types/events.js';
import { statusForEvent, type RunStore } from './store.js';

/**
 * Single-process store. Used by default when REDIS_URL is unset, and in tests,
 * so the whole app runs with no external dependency.
 */
interface RunRecord {
  run: Run;
  events: AgentEvent[];
  subscribers: Set<(event: AgentEvent) => void>;
}

const MAX_EVENTS_PER_RUN = 5_000;

export class MemoryRunStore implements RunStore {
  #runs = new Map<string, RunRecord>();
  #byIdempotencyKey = new Map<string, string>();
  #cancelHandlers: ((runId: string, reason: string) => void)[] = [];

  async create(
    goal: string,
    idempotencyKey: string | null,
  ): Promise<{ run: Run; replayed: boolean }> {
    if (idempotencyKey) {
      const existingId = this.#byIdempotencyKey.get(idempotencyKey);
      const existing = existingId ? this.#runs.get(existingId) : undefined;
      if (existing) return { run: existing.run, replayed: true };
    }

    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      goal,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      idempotencyKey,
    };

    this.#runs.set(run.id, { run, events: [], subscribers: new Set() });
    if (idempotencyKey) this.#byIdempotencyKey.set(idempotencyKey, run.id);
    return { run, replayed: false };
  }

  async get(runId: string): Promise<Run | undefined> {
    return this.#runs.get(runId)?.run;
  }

  async list(limit = 50): Promise<Run[]> {
    return [...this.#runs.values()]
      .map((r) => r.run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async append(runId: string, payload: AgentEventPayload): Promise<AgentEvent | undefined> {
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
      const status = statusForEvent(payload.type);
      if (status) record.run.status = status;
      record.run.updatedAt = event.ts;
    }

    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber(event);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
    return event;
  }

  async readFrom(runId: string, afterSeq: number): Promise<AgentEvent[]> {
    const record = this.#runs.get(runId);
    if (!record) return [];
    return record.events.filter((e) => e.seq > afterSeq);
  }

  async subscribe(
    runId: string,
    subscriber: (event: AgentEvent) => void,
  ): Promise<() => void> {
    const record = this.#runs.get(runId);
    if (!record) return () => {};
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }

  async requestCancel(runId: string, reason: string): Promise<void> {
    for (const handler of this.#cancelHandlers) handler(runId, reason);
  }

  onCancelRequest(handler: (runId: string, reason: string) => void): void {
    this.#cancelHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.#runs.clear();
    this.#byIdempotencyKey.clear();
  }
}
