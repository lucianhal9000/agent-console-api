#!/usr/bin/env node
/**
 * A stand-in for an OpenAI-compatible chat API.
 *
 * The LLM planner's riskiest code is parsing — JSON-mode plans, tool-call
 * arguments, and SSE token deltas — and none of it should need a paid API key
 * or a network round trip to test. This serves deterministic responses in the
 * real wire format so CI exercises the whole planner path for free.
 *
 *   node scripts/mock-llm.mjs            # listens on 5555
 *   LLM_BASE_URL=http://localhost:5555/v1 LLM_API_KEY=mock npm run dev
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 5555);

const PLAN = {
  steps: [
    { description: 'Work out the total cost', tool: 'calculator' },
    { description: 'Check the current date', tool: 'current_time' },
  ],
};

const TOOL_ARGS = {
  calculator: { expression: '(1200 * 0.18) + 45' },
  current_time: { timeZone: 'Asia/Kolkata' },
  http_get: { url: 'https://example.com' },
};

// Asking for the bad-expression plan exercises the permanent-failure path:
// the calculator rejects it, and the runtime must fail the step immediately
// rather than retrying something that can never succeed.
const BAD_PLAN = {
  steps: [{ description: 'Evaluate a broken expression', tool: 'calculator' }],
};
const BAD_ARGS = { calculator: { expression: '(1 + ' } };

const NARRATION = 'The tool returned a concrete value, which is enough to move on to the next step. ';

function json(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(payload);
}

function completion(content, toolCalls) {
  return {
    id: 'mock-completion',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content ?? '',
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
  };
}

async function streamNarration(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const word of NARRATION.split(' ')) {
    const frame = {
      choices: [{ index: 0, delta: { content: `${word} ` } }],
    };
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });

  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad_json"}');
      return;
    }

    if (body.stream) {
      void streamNarration(res);
      return;
    }

    const transcript = JSON.stringify(body.messages ?? '');
    const wantsFailure = transcript.includes('MOCK_PERMANENT_FAILURE');

    // JSON mode is only ever used for the plan.
    if (body.response_format?.type === 'json_object') {
      json(res, completion(JSON.stringify(wantsFailure ? BAD_PLAN : PLAN)));
      return;
    }

    // Tools present means "resolve the arguments for this one step".
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const name = body.tools[0]?.function?.name;
      const args = (wantsFailure ? BAD_ARGS[name] : TOOL_ARGS[name]) ?? {};
      json(
        res,
        completion('', [
          {
            id: `call_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ]),
      );
      return;
    }

    json(res, completion('Total cost is 261 and the date was retrieved successfully.'));
  });
});

server.listen(PORT, () => {
  console.log(`mock llm listening on http://localhost:${PORT}/v1`);
});
