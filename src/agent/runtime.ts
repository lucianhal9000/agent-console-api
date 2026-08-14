import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentEventPayload } from '../types/events.js';

export type Emit = (payload: AgentEventPayload) => void;

export interface PlannedStep {
  description: string;
  tool: string;
  args: unknown;
}

export interface Planner {
  /** Produce the ordered steps for a goal. */
  plan(goal: string, signal: AbortSignal): Promise<PlannedStep[]>;
  /** Run one tool call. Throwing marks the attempt failed and eligible for retry. */
  execute(step: PlannedStep, signal: AbortSignal): Promise<unknown>;
  /** Stream the narration for a step. */
  narrate(
    step: PlannedStep,
    result: unknown,
    signal: AbortSignal,
  ): AsyncIterable<string>;
  /** Final answer once every step is done. */
  summarize(
    goal: string,
    results: { step: PlannedStep; result: unknown }[],
    signal: AbortSignal,
  ): Promise<string>;
}

export interface RuntimeOptions {
  maxSteps: number;
  maxAttemptsPerStep: number;
  stepTimeoutMs: number;
  baseBackoffMs: number;
}

export const DEFAULT_OPTIONS: RuntimeOptions = {
  maxSteps: 12,
  maxAttemptsPerStep: 3,
  stepTimeoutMs: 20_000,
  baseBackoffMs: 400,
};

class Cancelled extends Error {}

/**
 * Drives a planner to completion, emitting the full event transcript.
 *
 * Resilience lives here, not in the planner: per-attempt timeouts, bounded
 * retries with exponential backoff and jitter, and cooperative cancellation
 * through a single AbortSignal. A step that exhausts its retries fails the
 * run rather than silently producing a partial answer.
 */
export async function runAgent(
  goal: string,
  planner: Planner,
  signal: AbortSignal,
  emit: Emit,
  options: RuntimeOptions = DEFAULT_OPTIONS,
): Promise<void> {
  let currentStep: number | null = null;

  try {
    emit({ type: 'run.started', goal });
    throwIfAborted(signal);

    const steps = (await planner.plan(goal, signal)).slice(0, options.maxSteps);
    emit({ type: 'plan.created', steps: steps.map((s) => s.description) });

    const results: { step: PlannedStep; result: unknown }[] = [];

    for (const [index, step] of steps.entries()) {
      throwIfAborted(signal);
      currentStep = index;
      emit({ type: 'step.started', index, description: step.description });

      const result = await executeWithRetry(planner, step, index, signal, emit, options);
      results.push({ step, result });

      let narration = '';
      for await (const token of planner.narrate(step, result, signal)) {
        throwIfAborted(signal);
        narration += token;
        emit({ type: 'token.delta', index, text: token });
      }

      emit({ type: 'step.completed', index, summary: narration.trim() });
    }

    currentStep = null;
    const answer = await planner.summarize(goal, results, signal);
    emit({ type: 'run.completed', answer });
  } catch (error) {
    if (signal.aborted || error instanceof Cancelled) {
      emit({ type: 'run.cancelled', reason: reasonOf(signal) });
      return;
    }
    emit({
      type: 'run.failed',
      error: error instanceof Error ? error.message : String(error),
      failedAtStep: currentStep,
    });
  }
}

async function executeWithRetry(
  planner: Planner,
  step: PlannedStep,
  index: number,
  signal: AbortSignal,
  emit: Emit,
  options: RuntimeOptions,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttemptsPerStep; attempt++) {
    throwIfAborted(signal);
    const callId = randomUUID();
    const startedAt = Date.now();

    emit({
      type: 'tool.call',
      index,
      tool: step.tool,
      args: step.args,
      attempt,
      callId,
    });

    try {
      const result = await withTimeout(
        (timeoutSignal) => planner.execute(step, timeoutSignal),
        options.stepTimeoutMs,
        signal,
      );
      emit({
        type: 'tool.result',
        index,
        tool: step.tool,
        callId,
        ok: true,
        result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      emit({
        type: 'tool.result',
        index,
        tool: step.tool,
        callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });

      if (attempt < options.maxAttemptsPerStep) {
        // Exponential backoff with full jitter, so simultaneous retries from
        // many runs don't line up into a thundering herd on the same tool.
        const ceiling = options.baseBackoffMs * 2 ** (attempt - 1);
        await delay(Math.random() * ceiling, undefined, { signal }).catch(() => {
          throw new Cancelled();
        });
      }
    }
  }

  throw new Error(
    `step ${index} (${step.tool}) failed after ${options.maxAttemptsPerStep} attempts: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !outer.aborted) {
      throw new Error(`timed out after ${ms}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled();
}

function reasonOf(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'cancelled';
}
