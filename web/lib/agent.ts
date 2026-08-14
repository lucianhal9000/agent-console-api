'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

/* ------------------------------------------------------------------ types */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string | null;
}

type Base = { seq: number; runId: string; ts: string };

export type AgentEvent = Base &
  (
    | { type: 'run.started'; goal: string }
    | { type: 'plan.created'; steps: string[] }
    | { type: 'step.started'; index: number; description: string }
    | { type: 'token.delta'; index: number; text: string }
    | { type: 'tool.call'; index: number; tool: string; args: unknown; attempt: number; callId: string }
    | {
        type: 'tool.result';
        index: number;
        tool: string;
        callId: string;
        ok: boolean;
        result?: unknown;
        error?: string;
        durationMs: number;
      }
    | { type: 'step.completed'; index: number; summary: string }
    | { type: 'run.completed'; answer: string }
    | { type: 'run.failed'; error: string; failedAtStep: number | null }
    | { type: 'run.cancelled'; reason: string }
  );

export const EVENT_TYPES: AgentEvent['type'][] = [
  'run.started',
  'plan.created',
  'step.started',
  'token.delta',
  'tool.call',
  'tool.result',
  'step.completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
];

/* ------------------------------------------------------------- derived state */

export interface ToolAttempt {
  callId: string;
  seq: number;
  tool: string;
  args: unknown;
  attempt: number;
  settled: boolean;
  ok?: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface StepState {
  index: number;
  seq: number;
  description: string;
  attempts: ToolAttempt[];
  narration: string;
  summary: string | null;
  done: boolean;
}

export interface RunState {
  goal: string | null;
  plan: string[];
  steps: StepState[];
  status: RunStatus | 'idle';
  answer: string | null;
  error: string | null;
  lastSeq: number;
  eventCount: number;
}

const EMPTY: RunState = {
  goal: null,
  plan: [],
  steps: [],
  status: 'idle',
  answer: null,
  error: null,
  lastSeq: 0,
  eventCount: 0,
};

/**
 * Folding events into state is a pure reduction, which is why a replayed run
 * renders byte-identically to one watched live — there is no separate "replay
 * mode", just the same events arriving faster.
 */
function reduce(state: RunState, event: AgentEvent): RunState {
  const next: RunState = {
    ...state,
    lastSeq: Math.max(state.lastSeq, event.seq),
    eventCount: state.eventCount + 1,
  };

  const patchStep = (index: number, patch: (step: StepState) => StepState): StepState[] =>
    next.steps.map((s) => (s.index === index ? patch(s) : s));

  switch (event.type) {
    case 'run.started':
      return { ...next, goal: event.goal, status: 'running' };

    case 'plan.created':
      return { ...next, plan: event.steps };

    case 'step.started':
      if (next.steps.some((s) => s.index === event.index)) return next;
      return {
        ...next,
        steps: [
          ...next.steps,
          {
            index: event.index,
            seq: event.seq,
            description: event.description,
            attempts: [],
            narration: '',
            summary: null,
            done: false,
          },
        ],
      };

    case 'token.delta':
      return {
        ...next,
        steps: patchStep(event.index, (s) => ({ ...s, narration: s.narration + event.text })),
      };

    case 'tool.call':
      return {
        ...next,
        steps: patchStep(event.index, (s) => ({
          ...s,
          attempts: [
            ...s.attempts,
            {
              callId: event.callId,
              seq: event.seq,
              tool: event.tool,
              args: event.args,
              attempt: event.attempt,
              settled: false,
            },
          ],
        })),
      };

    case 'tool.result':
      return {
        ...next,
        steps: patchStep(event.index, (s) => ({
          ...s,
          attempts: s.attempts.map((a) =>
            a.callId === event.callId
              ? {
                  ...a,
                  settled: true,
                  ok: event.ok,
                  result: event.result,
                  error: event.error,
                  durationMs: event.durationMs,
                }
              : a,
          ),
        })),
      };

    case 'step.completed':
      return {
        ...next,
        steps: patchStep(event.index, (s) => ({ ...s, done: true, summary: event.summary })),
      };

    case 'run.completed':
      return { ...next, status: 'succeeded', answer: event.answer };

    case 'run.failed':
      return { ...next, status: 'failed', error: event.error };

    case 'run.cancelled':
      return { ...next, status: 'cancelled', error: event.reason };

    default:
      return next;
  }
}

type Action = { kind: 'event'; event: AgentEvent } | { kind: 'reset' };

function reducer(state: RunState, action: Action): RunState {
  if (action.kind === 'reset') return EMPTY;
  return reduce(state, action.event);
}

/* --------------------------------------------------------------------- api */

export async function startRun(goal: string): Promise<Run> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // A retried submit (double-click, flaky network) reuses the run instead
      // of starting a second one.
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ goal }),
  });
  const body = (await response.json()) as { run?: Run; error?: string };
  if (!response.ok || !body.run) throw new Error(body.error ?? 'Could not start the run');
  return body.run;
}

export async function cancelRun(runId: string): Promise<void> {
  const response = await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
  if (!response.ok && response.status !== 409) {
    throw new Error('Could not cancel the run');
  }
}

export async function listRuns(): Promise<Run[]> {
  const response = await fetch('/api/runs');
  if (!response.ok) return [];
  const body = (await response.json()) as { runs?: Run[] };
  return body.runs ?? [];
}

export async function fetchBackend(): Promise<string | null> {
  try {
    const response = await fetch('/health');
    const body = (await response.json()) as { backend?: string };
    return body.backend ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- hook */

export type Connection = 'idle' | 'open' | 'reconnecting' | 'closed';

/**
 * Subscribes to a run's event stream.
 *
 * The reconnect cursor is handled by the browser: EventSource remembers the
 * last `id:` it saw and sends it back as `Last-Event-ID` automatically. The
 * server replays from there, so a dropped connection costs nothing and needs no
 * code here — which is the whole reason every event carries a seq.
 */
export function useRunStream(runId: string | null): {
  state: RunState;
  connection: Connection;
} {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [connection, setConnection] = useState<Connection>('idle');
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    dispatch({ kind: 'reset' });
    if (!runId) {
      setConnection('idle');
      return;
    }

    const source = new EventSource(`/api/runs/${runId}/events`);
    sourceRef.current = source;
    setConnection('reconnecting');

    source.onopen = () => setConnection('open');
    source.onerror = () => {
      // EventSource retries on its own; CLOSED means it has given up.
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };

    const terminal = new Set(['run.completed', 'run.failed', 'run.cancelled']);

    const handlers = EVENT_TYPES.map((type) => {
      const handler = (message: MessageEvent<string>) => {
        let event: AgentEvent;
        try {
          event = JSON.parse(message.data) as AgentEvent;
        } catch {
          return;
        }
        dispatch({ kind: 'event', event });
        if (terminal.has(event.type)) {
          // Without this the browser would reconnect forever to a finished run.
          source.close();
          setConnection('closed');
        }
      };
      source.addEventListener(type, handler as EventListener);
      return { type, handler };
    });

    return () => {
      for (const { type, handler } of handlers) {
        source.removeEventListener(type, handler as EventListener);
      }
      source.close();
      sourceRef.current = null;
    };
  }, [runId]);

  return { state, connection };
}

/* ------------------------------------------------------------------ helpers */

export function useRunList(refreshKey: number): Run[] {
  const [runs, setRuns] = useState<Run[]>([]);
  const load = useCallback(() => {
    void listRuns().then(setRuns);
  }, []);
  useEffect(load, [load, refreshKey]);
  return runs;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function preview(value: unknown, max = 120): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
