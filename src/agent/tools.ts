import { z } from 'zod';

/**
 * The tools the agent can actually call. These are real — the calculator
 * evaluates, the fetcher makes a request — so failures here are genuine
 * failures, which is the point: the retry and partial-failure machinery in
 * the runtime only means something if the things it wraps can really break.
 */

/**
 * A failure the runtime should not retry. Bad arguments, a missing page, and an
 * unknown time zone all fail identically every time — retrying them only makes
 * the failure slower and noisier.
 */
export class PermanentToolError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentToolError';
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, sent to the model as a function definition. */
  parameters: Record<string, unknown>;
  /** Validates the model's arguments before anything runs. */
  schema: z.ZodTypeAny;
  run(args: unknown, signal: AbortSignal): Promise<unknown>;
}

/* --------------------------------------------------------------- calculator */

/**
 * Recursive-descent parser for arithmetic. Deliberately not `eval` or
 * `new Function`: tool arguments come from a model, which means they are
 * untrusted input, and handing untrusted input to an evaluator is how a
 * calculator tool becomes remote code execution.
 */
function evaluateExpression(input: string): number {
  let pos = 0;

  const peek = (): string => input[pos] ?? '';
  const skipSpace = (): void => {
    while (/\s/.test(peek())) pos++;
  };

  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== '+' && op !== '-') return value;
      pos++;
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
  }

  function parseTerm(): number {
    let value = parsePower();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return value;
      pos++;
      const right = parsePower();
      if ((op === '/' || op === '%') && right === 0) {
        throw new Error('division by zero');
      }
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
  }

  function parsePower(): number {
    const base = parseUnary();
    skipSpace();
    if (peek() === '^') {
      pos++;
      // Right-associative: 2^3^2 is 2^9, not 8^2.
      return base ** parsePower();
    }
    return base;
  }

  function parseUnary(): number {
    skipSpace();
    if (peek() === '-') {
      pos++;
      return -parseUnary();
    }
    if (peek() === '+') {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    skipSpace();
    if (peek() === '(') {
      pos++;
      const value = parseExpression();
      skipSpace();
      if (peek() !== ')') throw new Error('unbalanced parentheses');
      pos++;
      return value;
    }
    const match = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(pos));
    if (!match) throw new Error(`unexpected character at position ${pos}`);
    pos += match[0].length;
    return Number.parseFloat(match[0]);
  }

  const result = parseExpression();
  skipSpace();
  if (pos !== input.length) throw new Error(`unexpected trailing input at position ${pos}`);
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');
  return result;
}

const calculatorArgs = z.object({
  expression: z.string().min(1).max(500),
});

export const calculator: ToolDefinition = {
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression. Supports + - * / % ^ and parentheses. Use this instead of doing arithmetic yourself.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The expression to evaluate, e.g. "(1200 * 0.18) + 45"',
      },
    },
    required: ['expression'],
  },
  schema: calculatorArgs,
  async run(args) {
    const { expression } = calculatorArgs.parse(args);
    try {
      return { expression, value: evaluateExpression(expression) };
    } catch (error) {
      throw new PermanentToolError(error instanceof Error ? error.message : 'invalid expression');
    }
  },
};

/* ---------------------------------------------------------------- http_get */

const BLOCKED_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

const httpGetArgs = z.object({
  url: z.string().url(),
});

export const httpGet: ToolDefinition = {
  name: 'http_get',
  description:
    'Fetch a public HTTPS page and return its text content, truncated. Only use this with a URL the user gave you or that you know exists. Never guess or construct a URL. Never use this to find the date or time.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'An absolute https:// URL' },
    },
    required: ['url'],
  },
  schema: httpGetArgs,
  async run(args, signal) {
    const { url } = httpGetArgs.parse(args);
    const parsed = new URL(url);

    // A model choosing the URL means this tool is an SSRF primitive unless it
    // is fenced: public HTTPS only, never the loopback or private ranges that
    // would let a prompt reach cloud metadata or internal services.
    if (parsed.protocol !== 'https:') {
      throw new PermanentToolError('only https:// URLs are allowed');
    }
    if (BLOCKED_HOST.test(parsed.hostname)) {
      throw new PermanentToolError('that host is not reachable');
    }

    const response = await fetch(parsed, {
      signal,
      redirect: 'follow',
      headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (!response.ok) {
      // 408 and 429 are the two 4xx codes that genuinely mean "try again";
      // every other 4xx will return the same answer forever.
      const transient = response.status >= 500 || response.status === 408 || response.status === 429;
      const message = `upstream returned ${response.status}`;
      throw transient ? new Error(message) : new PermanentToolError(message);
    }

    const raw = (await response.text()).slice(0, 40_000);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2_000);

    return { url: parsed.toString(), status: response.status, text };
  },
};

/* ------------------------------------------------------------ current_time */

const timeArgs = z.object({
  timeZone: z.string().optional(),
});

export const currentTime: ToolDefinition = {
  name: 'current_time',
  description:
    'Get the current date and time in any IANA time zone. Always use this for anything about the current date or time, in any location — never fetch a web page for it.',
  parameters: {
    type: 'object',
    properties: {
      timeZone: { type: 'string', description: 'IANA zone, e.g. "Asia/Kolkata". Defaults to UTC.' },
    },
  },
  schema: timeArgs,
  async run(args) {
    const { timeZone } = timeArgs.parse(args);
    const now = new Date();
    try {
      return {
        iso: now.toISOString(),
        formatted: new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timeZone ?? 'UTC',
        }).format(now),
        timeZone: timeZone ?? 'UTC',
      };
    } catch {
      throw new PermanentToolError(`unknown time zone: ${timeZone ?? ''}`);
    }
  },
};

/* ---------------------------------------------------------------- registry */

export const TOOLS: ToolDefinition[] = [calculator, httpGet, currentTime];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** The tool list in the shape chat-completions APIs expect. */
export function toolSchemas(): unknown[] {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
