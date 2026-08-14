import type { AgentEvent, AgentEventPayload, Run, RunStatus } from '../types/events.js';

/**
 * Everything the routes and the runtime need from a store, and nothing more.
 *
 * Two implementations satisfy this: an in-memory one (no dependencies, used by
 * default and in tests) and a Redis one (durable, multi-process). Every method
 * is async so the same call sites work against both.
 */
export interface RunStore {
  /**
   * Create a run, or return the existing one when `idempotencyKey` has been
   * seen before. `replayed` distinguishes the two.
   */
  create(goal: string, idempotencyKey: string | null): Promise<{ run: Run; replayed: boolean }>;

  get(runId: string): Promise<Run | undefined>;

  list(limit?: number): Promise<Run[]>;

  /** Append an event, assign it the next seq, and fan it out to subscribers. */
  append(runId: string, payload: AgentEventPayload): Promise<AgentEvent | undefined>;

  /** Every persisted event strictly after `afterSeq`. */
  readFrom(runId: string, afterSeq: number): Promise<AgentEvent[]>;

  /** Returns an unsubscribe function. */
  subscribe(runId: string, subscriber: (event: AgentEvent) => void): Promise<() => void>;

  /**
   * Broadcast a cancellation request. The process actually executing the run
   * may be a different one, which is why this is a broadcast rather than a
   * direct abort.
   */
  requestCancel(runId: string, reason: string): Promise<void>;

  /** Register a handler invoked when any process requests a cancellation. */
  onCancelRequest(handler: (runId: string, reason: string) => void): void;

  close(): Promise<void>;
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Which run status a terminal event implies. */
export function statusForEvent(type: AgentEventPayload['type']): RunStatus | null {
  if (type === 'run.completed') return 'succeeded';
  if (type === 'run.failed') return 'failed';
  if (type === 'run.cancelled') return 'cancelled';
  return null;
}

/**
 * Tracks AbortControllers for runs this process is executing.
 *
 * Cancellation arrives as a broadcast every process hears; only the one holding
 * the controller for that run acts on it, and the rest ignore it. That is what
 * makes cancel work when the API request and the running agent land on
 * different instances.
 */
export class LocalRunRegistry {
  #controllers = new Map<string, AbortController>();

  register(runId: string): AbortSignal {
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    return controller.signal;
  }

  abort(runId: string, reason: string): boolean {
    const controller = this.#controllers.get(runId);
    if (!controller) return false;
    controller.abort(new Error(reason));
    return true;
  }

  release(runId: string): void {
    this.#controllers.delete(runId);
  }

  get size(): number {
    return this.#controllers.size;
  }
}
