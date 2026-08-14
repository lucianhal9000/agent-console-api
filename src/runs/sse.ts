import type { Response } from 'express';
import type { AgentEvent } from '../types/events.js';

const HEARTBEAT_MS = 15_000;

/**
 * Backpressure policy.
 *
 * `res.write()` returning false means the socket buffer is full — a slow or
 * backgrounded client. Rather than let the queue grow without bound we:
 *   1. buffer up to SOFT_LIMIT events,
 *   2. past that, collapse consecutive token.delta frames for the same step
 *      into one (the text still arrives, just in fewer frames),
 *   3. past HARD_LIMIT, close the connection. The client reconnects with
 *      Last-Event-ID and gets an exact replay, so nothing is lost.
 */
const SOFT_LIMIT = 200;
const HARD_LIMIT = 1_000;

export class SseStream {
  #res: Response;
  #queue: AgentEvent[] = [];
  #draining = false;
  #closed = false;
  #heartbeat: NodeJS.Timeout;

  constructor(res: Response) {
    this.#res = res;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Defeats proxy buffering (nginx and friends), which otherwise holds
    // frames until the response ends and makes streaming look broken.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(': connected\n\n');

    this.#heartbeat = setInterval(() => {
      if (!this.#closed) this.#res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    res.on('close', () => this.close());
    res.on('drain', () => this.#flush());
  }

  send(event: AgentEvent): void {
    if (this.#closed) return;
    this.#queue.push(event);
    this.#applyBackpressure();
    this.#flush();
  }

  #applyBackpressure(): void {
    if (this.#queue.length <= SOFT_LIMIT) return;

    const coalesced: AgentEvent[] = [];
    for (const event of this.#queue) {
      const prev = coalesced.at(-1);
      if (
        event.type === 'token.delta' &&
        prev?.type === 'token.delta' &&
        prev.index === event.index
      ) {
        coalesced[coalesced.length - 1] = {
          ...event,
          text: prev.text + event.text,
        };
      } else {
        coalesced.push(event);
      }
    }
    this.#queue = coalesced;

    if (this.#queue.length > HARD_LIMIT) {
      this.#res.write(': overflow, reconnect with Last-Event-ID\n\n');
      this.close();
    }
  }

  #flush(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;

    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (!event) break;
      const frame =
        `id: ${event.seq}\n` +
        `event: ${event.type}\n` +
        `data: ${JSON.stringify(event)}\n\n`;
      const ok = this.#res.write(frame);
      if (!ok) break; // wait for 'drain'
    }

    this.#draining = false;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#res.end();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

/** Parses the reconnect cursor from either the header or the query string. */
export function parseLastEventId(
  header: string | undefined,
  query: unknown,
): number {
  const raw = header ?? (typeof query === 'string' ? query : undefined);
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
