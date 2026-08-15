import { z } from 'zod';
import { LlmClient, type ChatMessage } from './llm.js';
import { findTool, TOOLS, toolSchemas } from './tools.js';
import type { Planner, PlannedStep, StepContext, StepResult } from './runtime.js';

/**
 * A plan-and-execute planner backed by a real model.
 *
 * It drops into the same `Planner` interface as the scripted one, so the
 * runtime, the routes, the store, and the console are all untouched by this
 * file existing — which was the point of putting orchestration in the runtime
 * rather than in the planner.
 */

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        description: z.string().min(1),
        tool: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
});

const TOOL_NAMES = TOOLS.map((tool) => tool.name).join(', ');

export class LlmPlanner implements Planner {
  #llm: LlmClient;

  constructor(llm: LlmClient) {
    this.#llm = llm;
  }

  async plan(goal: string, signal: AbortSignal): Promise<PlannedStep[]> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You plan short tool-using workflows. Break the goal into the fewest steps that actually need a tool.',
          `Available tools: ${TOOL_NAMES}.`,
          'Reply with JSON only: {"steps":[{"description":"...","tool":"<tool name>"}]}.',
          'Do not include arguments — those are decided later, once earlier results are known.',
          'Never plan a step whose tool is not in the list.',
          // Both of these are failures seen in practice: the model split one
          // expression across two calculator steps, then reached for http_get
          // at an invented URL when current_time was sitting right there.
          'Use one step per tool call, and do not split work a single call can do — a whole arithmetic expression is one calculator step, not several.',
          'Always prefer the most specific tool for the job. Only plan http_get when the user supplied a URL or named a specific page; never to look up the date, the time, or a fact a dedicated tool covers.',
        ].join(' '),
      },
      { role: 'user', content: goal },
    ];

    const { content } = await this.#llm.complete(
      { messages, responseFormat: 'json_object', temperature: 0.1 },
      signal,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(content));
    } catch {
      throw new Error('the model did not return valid JSON for the plan');
    }

    const plan = planSchema.safeParse(parsed);
    if (!plan.success) {
      throw new Error('the model returned a plan in an unexpected shape');
    }

    // A hallucinated tool name is a planning failure, not a runtime surprise —
    // better to fail here with a clear message than three steps in.
    for (const step of plan.data.steps) {
      if (!findTool(step.tool)) {
        throw new Error(`the model planned an unknown tool: ${step.tool}`);
      }
    }

    return plan.data.steps.map((step) => ({
      description: step.description,
      tool: step.tool,
      args: null,
    }));
  }

  async prepare(
    step: PlannedStep,
    context: StepContext,
    signal: AbortSignal,
  ): Promise<PlannedStep> {
    const tool = findTool(step.tool);
    if (!tool) throw new Error(`unknown tool: ${step.tool}`);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          `You are executing one step of a plan. Call the ${tool.name} tool exactly once.`,
          'Use the results of earlier steps where they are relevant.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Goal: ${context.goal}`,
          '',
          `This step: ${step.description}`,
          '',
          context.prior.length > 0
            ? `Earlier results:\n${context.prior
                .map((entry, index) => `${index + 1}. ${entry.step.tool} → ${truncate(entry.result)}`)
                .join('\n')}`
            : 'No earlier steps.',
        ].join('\n'),
      },
    ];

    const { toolCalls } = await this.#llm.complete(
      {
        messages,
        // Restricted to this step's tool: the plan already decided which tool
        // runs, and letting the model swap it here would make the plan a lie.
        tools: toolSchemas().filter(
          (schema) => (schema as { function: { name: string } }).function.name === tool.name,
        ),
        toolChoice: 'required',
        temperature: 0.1,
      },
      signal,
    );

    const call = toolCalls[0];
    if (!call) throw new Error(`the model did not call ${tool.name}`);

    let args: unknown;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error(`the model sent malformed arguments for ${tool.name}`);
    }

    const validated = tool.schema.safeParse(args);
    if (!validated.success) {
      throw new Error(
        `invalid arguments for ${tool.name}: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    return { ...step, args: validated.data };
  }

  async execute(step: PlannedStep, _context: StepContext, signal: AbortSignal): Promise<unknown> {
    const tool = findTool(step.tool);
    if (!tool) throw new Error(`unknown tool: ${step.tool}`);
    return tool.run(step.args, signal);
  }

  async *narrate(
    step: PlannedStep,
    result: unknown,
    context: StepContext,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Explain in one or two plain sentences what this step found and what it means for the goal. No preamble, no bullet points.',
      },
      {
        role: 'user',
        content: [
          `Goal: ${context.goal}`,
          `Step: ${step.description}`,
          `Tool: ${step.tool}`,
          `Result: ${truncate(result, 900)}`,
        ].join('\n'),
      },
    ];

    yield* this.#llm.stream({ messages, maxTokens: 200 }, signal);
  }

  async summarize(goal: string, results: StepResult[], signal: AbortSignal): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Answer the goal directly using the step results. Be specific and concise. If the results do not answer it, say so plainly rather than guessing.',
      },
      {
        role: 'user',
        content: [
          `Goal: ${goal}`,
          '',
          'Step results:',
          ...results.map(
            (entry, index) => `${index + 1}. ${entry.step.description} (${entry.step.tool}) → ${truncate(entry.result)}`,
          ),
        ].join('\n'),
      },
    ];

    const { content } = await this.#llm.complete({ messages, maxTokens: 400 }, signal);
    return content.trim() || 'The run finished but the model returned no answer.';
  }
}

/** Some models wrap JSON in a markdown fence even when told not to. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

function truncate(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
