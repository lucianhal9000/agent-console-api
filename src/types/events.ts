/**
 * The wire contract between the agent runtime and any client.
 *
 * Every event is persisted with a monotonic `seq` per run and emitted as the
 * SSE `id:` field. A client that drops its connection reconnects with
 * `Last-Event-ID: <seq>` and the server replays everything after it, so a
 * refresh mid-run never loses the transcript. This is also what makes replay
 * of a finished run free: it is the same code path with no live subscriber.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AgentEventPayload =
  | { type: 'run.started'; goal: string }
  | { type: 'plan.created'; steps: string[] }
  | { type: 'step.started'; index: number; description: string }
  | { type: 'token.delta'; index: number; text: string }
  | {
      type: 'tool.call';
      index: number;
      tool: string;
      args: unknown;
      attempt: number;
      callId: string;
    }
  | {
      type: 'tool.result';
      index: number;
      tool: string;
      callId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      /** False when the error is permanent and no retry was attempted. */
      retryable?: boolean;
      durationMs: number;
    }
  | { type: 'step.completed'; index: number; summary: string }
  | { type: 'run.completed'; answer: string }
  | { type: 'run.failed'; error: string; failedAtStep: number | null }
  | { type: 'run.cancelled'; reason: string }
  | { type: 'heartbeat' };

export type AgentEventType = AgentEventPayload['type'];

/** An event once the store has stamped it. */
export type AgentEvent = AgentEventPayload & {
  seq: number;
  runId: string;
  ts: string;
};

/** Events after which no further events can arrive for a run. */
export const TERMINAL_EVENTS = new Set<AgentEventType>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string | null;
}
