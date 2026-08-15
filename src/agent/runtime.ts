import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentEventPayload } from '../types/events.js';

export type Emit = (payload: AgentEventPayload) => void;

export interface PlannedStep {
  description: string;
  tool: string;
  args: unknown;
}

export interface StepResult {
  step: PlannedStep;
  result: unknown;
}

/** What a step knows about the run so far. */
export interface StepContext {
  goal: string;
  plan: PlannedStep[];
  prior: StepResult[];
}

export interface Planner {
  /** Produce the ordered steps for a goal. */
  plan(goal: string, signal: AbortSignal): Promise<PlannedStep[]>;

  /**
   * Optional. Resolve a step's arguments now that earlier results are known,
   * called once per step before the first attempt.
   *
   * A planner that fixes every argument up front cannot let step 3's query
   * depend on step 2's answer, which is most of what makes a multi-step agent
   * worth having. Retries reuse the resolved step rather than re-deriving it:
   * a transient 503 is not a reason to change what you asked for.
   */
  prepare?(step: PlannedStep, context: StepContext, signal: AbortSignal): Promise<PlannedStep>;

  /** Run one tool call. Throwing marks the attempt failed and eligible for retry. */
  execute(step: PlannedStep, context: StepContext, signal: AbortSignal): Promise<unknown>;

  /** Stream the narration for a step. */
  narrate(
    step: PlannedStep,
    result: unknown,
    context: StepContext,
    signal: AbortSignal,
  ): AsyncIterable<string>;

  /** Final answer once every step is done. */
  summarize(goal: string, results: StepResult[], signal: AbortSignal): Promise<string>;
}

/**
 * Whether an error is worth trying again.
 *
 * Retrying everything is a real cost, not just wasted time: a 404 or a
 * malformed argument will fail identically on every attempt, so three tries
 * with backoff turns an instant failure into a slow one and buries the actual
 * cause under duplicates. Anything that does not say otherwise is treated as
 * transient, so a tool has to opt out deliberately.
 */
export function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable !== false;
  }
  return true;
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

    const results: StepResult[] = [];

    for (const [index, planned] of steps.entries()) {
      throwIfAborted(signal);
      currentStep = index;
      emit({ type: 'step.started', index, description: planned.description });

      const context: StepContext = { goal, plan: steps, prior: [...results] };

      // Resolving arguments is itself fallible — a model can return malformed
      // JSON or name a tool that doesn't exist — so it fails the step like any
      // other error rather than throwing past the emit boundary.
      const step = planner.prepare
        ? await planner.prepare(planned, context, signal)
        : planned;

      const result = await executeWithRetry(planner, step, context, index, signal, emit, options);
      results.push({ step, result });

      let narration = '';
      for await (const token of planner.narrate(step, result, context, signal)) {
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
  context: StepContext,
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
        (timeoutSignal) => planner.execute(step, context, timeoutSignal),
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
      const retryable = isRetryable(error);
      emit({
        type: 'tool.result',
        index,
        tool: step.tool,
        callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable,
        durationMs: Date.now() - startedAt,
      });

      if (!retryable) break;

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

  const cause = lastError instanceof Error ? lastError.message : String(lastError);
  const attempts = isRetryable(lastError)
    ? `after ${options.maxAttemptsPerStep} attempts`
    : 'and was not retried';
  // One-based, matching how every step is labelled in the transcript and the
  // console. An error message that disagrees with the UI costs someone minutes
  // at exactly the moment they can least afford them.
  throw new Error(`step ${index + 1} (${step.tool}) failed ${attempts}: ${cause}`);
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
