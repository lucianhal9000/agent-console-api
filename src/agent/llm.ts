/**
 * A small client for any OpenAI-compatible /chat/completions endpoint.
 *
 * Written by hand rather than pulled from an SDK because the only two things
 * this project needs from a model API are tool calls and a token stream, and
 * both are a dozen lines each. Keeping it thin also means the provider is a
 * base URL, so Groq, OpenAI, Together, or a local server all work unchanged.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function llmConfigFromEnv(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1',
    model: process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile',
  };
}

interface CompletionRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object';
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
}

export class LlmClient {
  #config: LlmConfig;

  constructor(config: LlmConfig) {
    this.#config = config;
  }

  get model(): string {
    return this.#config.model;
  }

  async #post(body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.#config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      // Surfaced verbatim into a tool.result event, so keep it short and useful.
      throw new Error(`model API ${response.status}: ${detail}`);
    }
    return response;
  }

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const response = await this.#post(
      {
        model: this.#config.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
        ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 1024,
      },
      signal,
    );

    const body = (await response.json()) as {
      choices?: { message?: ChatMessage }[];
    };
    const message = body.choices?.[0]?.message;

    return {
      content: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    };
  }

  /**
   * Streams assistant text token by token.
   *
   * The SSE framing here is the provider's, not ours — same wire format, but
   * the events carry OpenAI-shaped deltas and terminate with a literal
   * `[DONE]` sentinel rather than a typed event.
   */
  async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<string> {
    const response = await this.#post(
      {
        model: this.#config.model,
        messages: request.messages,
        stream: true,
        temperature: request.temperature ?? 0.4,
        max_tokens: request.maxTokens ?? 512,
      },
      signal,
    );

    if (!response.body) throw new Error('model API returned no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; hold back any partial tail.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return;
            try {
              const parsed = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const text = parsed.choices?.[0]?.delta?.content;
              if (text) yield text;
            } catch {
              // A malformed frame shouldn't kill the stream.
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
