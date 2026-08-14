import { setTimeout as delay } from 'node:timers/promises';
import type { Planner, PlannedStep } from './runtime.js';

/**
 * Phase 1 planner. No LLM, no API key — it produces a realistic event stream so
 * the transport, orchestration, and UI can be built and tested deterministically.
 * Phase 2 replaces this with an LLM planner behind the same interface; nothing
 * in runtime.ts, the routes, or the client changes.
 */
export class ScriptedPlanner implements Planner {
  #flakyAttempts = new Map<string, number>();

  async plan(goal: string, signal: AbortSignal): Promise<PlannedStep[]> {
    await delay(300, undefined, { signal });
    return [
      {
        description: `Break down the request: "${goal}"`,
        tool: 'decompose',
        args: { goal },
      },
      {
        description: 'Look up supporting information',
        tool: 'search',
        args: { query: goal, limit: 5 },
      },
      {
        description: 'Cross-check the numbers',
        tool: 'flaky_calculator',
        args: { expression: 'sum(results)' },
      },
      {
        description: 'Draft the answer',
        tool: 'compose',
        args: { style: 'concise' },
      },
    ];
  }

  async execute(step: PlannedStep, signal: AbortSignal): Promise<unknown> {
    await delay(400 + Math.random() * 600, undefined, { signal });

    if (step.tool === 'flaky_calculator') {
      // Fails the first two attempts, then succeeds — exercises the retry
      // path and gives the UI something real to render for a failed attempt.
      const seen = (this.#flakyAttempts.get(step.description) ?? 0) + 1;
      this.#flakyAttempts.set(step.description, seen);
      if (seen < 3) throw new Error('upstream calculator returned 503');
      return { value: 42, confidence: 0.91 };
    }

    if (step.tool === 'search') {
      return {
        hits: [
          { title: 'Primary source', score: 0.94 },
          { title: 'Secondary source', score: 0.71 },
        ],
      };
    }

    return { ok: true, tool: step.tool };
  }

  async *narrate(
    step: PlannedStep,
    _result: unknown,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const text = `Completed ${step.tool}. ${step.description} is done and the output looks consistent with the goal. `;
    for (const word of text.split(' ')) {
      await delay(40, undefined, { signal });
      yield word + ' ';
    }
  }

  async summarize(
    goal: string,
    results: { step: PlannedStep; result: unknown }[],
    signal: AbortSignal,
  ): Promise<string> {
    await delay(300, undefined, { signal });
    return `Ran ${results.length} steps for "${goal}" and reached a consistent result.`;
  }
}
