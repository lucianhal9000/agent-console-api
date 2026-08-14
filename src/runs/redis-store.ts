import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { TERMINAL_EVENTS, type AgentEvent, type AgentEventPayload, type Run } from '../types/events.js';
import { statusForEvent, type RunStore } from './store.js';

/**
 * Redis-backed store: durable transcripts, resume across restarts, and fan-out
 * across processes.
 *
 * Layout
 *   run:{id}          hash    run metadata
 *   run:{id}:events   stream  the transcript, one entry per event
 *   run:{id}:seq      counter monotonic seq, the SSE event id
 *   runs:index        zset    run ids scored by creation time
 *   idem:{key}        string  idempotency key -> run id
 *   agent:events:{id} channel live fan-out to SSE subscribers
 *   agent:control     channel cancellation broadcast
 *
 * Everything except runs:index carries a TTL, so a free-tier instance can't
 * fill up with abandoned transcripts. runs:index is pruned lazily on list().
 */

const CONTROL_CHANNEL = 'agent:control';

/**
 * Appends one event atomically: bump the counter, splice the seq into the
 * already-serialised payload, persist, publish, and refresh the TTLs.
 *
 * The seq is spliced textually rather than via cjson round-tripping, which
 * would silently rewrite number formats and collapse empty objects into empty
 * arrays. The payload is always a JSON object with at least a `type` field, so
 * dropping the trailing brace and appending `,"seq":N}` is safe.
 */
const APPEND_SCRIPT = `
local seqKey, streamKey, runKey, channel = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local payload, ttl, terminalStatus, ts = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4]

if redis.call('EXISTS', runKey) == 0 then
  return nil
end

local seq = redis.call('INCR', seqKey)
local encoded = string.sub(payload, 1, -2) .. ',"seq":' .. seq .. '}'

redis.call('XADD', streamKey, '*', 'e', encoded)
redis.call('PUBLISH', channel, encoded)
redis.call('EXPIRE', seqKey, ttl)
redis.call('EXPIRE', streamKey, ttl)

if terminalStatus ~= '' then
  redis.call('HSET', runKey, 'status', terminalStatus, 'updatedAt', ts)
  redis.call('EXPIRE', runKey, ttl)
end

return encoded
`;

export interface RedisRunStoreOptions {
  url: string;
  /** How long a run's transcript survives. Default 24h. */
  ttlSeconds?: number;
}

export class RedisRunStore implements RunStore {
  #redis: Redis;
  #sub: Redis;
  #ttl: number;
  #channelSubscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  #cancelHandlers: ((runId: string, reason: string) => void)[] = [];
  #ready: Promise<void>;

  constructor(options: RedisRunStoreOptions) {
    this.#ttl = options.ttlSeconds ?? 86_400;
    this.#redis = new Redis(options.url, { maxRetriesPerRequest: 3 });
    // Pub/sub puts a connection into subscriber mode, where it can't serve
    // normal commands — so it needs its own connection.
    this.#sub = this.#redis.duplicate();

    this.#sub.on('message', (channel: string, message: string) => {
      if (channel === CONTROL_CHANNEL) {
        this.#handleControl(message);
        return;
      }
      const subscribers = this.#channelSubscribers.get(channel);
      if (!subscribers) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(message) as AgentEvent;
      } catch {
        return;
      }
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch {
          subscribers.delete(subscriber);
        }
      }
    });

    this.#ready = this.#sub.subscribe(CONTROL_CHANNEL).then(() => undefined);
  }

  async ready(): Promise<void> {
    await this.#ready;
    await this.#redis.ping();
  }

  #handleControl(message: string): void {
    let parsed: { runId?: string; reason?: string };
    try {
      parsed = JSON.parse(message) as { runId?: string; reason?: string };
    } catch {
      return;
    }
    if (!parsed.runId) return;
    for (const handler of this.#cancelHandlers) {
      handler(parsed.runId, parsed.reason ?? 'cancelled');
    }
  }

  async create(
    goal: string,
    idempotencyKey: string | null,
  ): Promise<{ run: Run; replayed: boolean }> {
    const now = new Date();
    const run: Run = {
      id: randomUUID(),
      goal,
      status: 'running',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      idempotencyKey,
    };

    if (idempotencyKey) {
      // SET NX is the whole idempotency mechanism: the first caller claims the
      // key, everyone else reads back the run id the winner wrote.
      const claimed = await this.#redis.set(
        `idem:${idempotencyKey}`,
        run.id,
        'EX',
        this.#ttl,
        'NX',
      );
      if (claimed === null) {
        const existingId = await this.#redis.get(`idem:${idempotencyKey}`);
        const existing = existingId ? await this.get(existingId) : undefined;
        // If the key expired between SET and GET, fall through and create.
        if (existing) return { run: existing, replayed: true };
      }
    }

    await this.#redis
      .multi()
      .hset(`run:${run.id}`, {
        id: run.id,
        goal: run.goal,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        idempotencyKey: idempotencyKey ?? '',
      })
      .expire(`run:${run.id}`, this.#ttl)
      .zadd('runs:index', now.getTime(), run.id)
      .exec();

    return { run, replayed: false };
  }

  async get(runId: string): Promise<Run | undefined> {
    const hash = await this.#redis.hgetall(`run:${runId}`);
    if (!hash || Object.keys(hash).length === 0) return undefined;
    return hashToRun(hash);
  }

  async list(limit = 50): Promise<Run[]> {
    // Prune index entries whose runs have aged out, so the index doesn't grow
    // unbounded while the runs themselves expire underneath it.
    const cutoff = Date.now() - this.#ttl * 1_000;
    await this.#redis.zremrangebyscore('runs:index', '-inf', cutoff);

    const ids = await this.#redis.zrevrange('runs:index', 0, limit - 1);
    if (ids.length === 0) return [];

    const pipeline = this.#redis.pipeline();
    for (const id of ids) pipeline.hgetall(`run:${id}`);
    const results = await pipeline.exec();
    if (!results) return [];

    const runs: Run[] = [];
    for (const [error, value] of results) {
      if (error || !value) continue;
      const hash = value as Record<string, string>;
      if (Object.keys(hash).length === 0) continue;
      runs.push(hashToRun(hash));
    }
    return runs;
  }

  async append(runId: string, payload: AgentEventPayload): Promise<AgentEvent | undefined> {
    if (payload.type === 'heartbeat') return undefined;

    const ts = new Date().toISOString();
    // seq is added by the script; everything else is fixed here.
    const partial = JSON.stringify({ ...payload, runId, ts });
    const terminalStatus = TERMINAL_EVENTS.has(payload.type)
      ? (statusForEvent(payload.type) ?? '')
      : '';

    const encoded = (await this.#redis.eval(
      APPEND_SCRIPT,
      4,
      `run:${runId}:seq`,
      `run:${runId}:events`,
      `run:${runId}`,
      `agent:events:${runId}`,
      partial,
      String(this.#ttl),
      terminalStatus,
      ts,
    )) as string | null;

    if (!encoded) return undefined;
    return JSON.parse(encoded) as AgentEvent;
  }

  async readFrom(runId: string, afterSeq: number): Promise<AgentEvent[]> {
    const entries = await this.#redis.xrange(`run:${runId}:events`, '-', '+');
    const events: AgentEvent[] = [];
    for (const [, fields] of entries) {
      // Fields come back as a flat [name, value, ...] array.
      const index = fields.indexOf('e');
      if (index === -1) continue;
      const raw = fields[index + 1];
      if (!raw) continue;
      try {
        const event = JSON.parse(raw) as AgentEvent;
        if (event.seq > afterSeq) events.push(event);
      } catch {
        // A corrupt entry shouldn't sink the whole replay.
      }
    }
    return events;
  }

  async subscribe(
    runId: string,
    subscriber: (event: AgentEvent) => void,
  ): Promise<() => void> {
    const channel = `agent:events:${runId}`;
    let subscribers = this.#channelSubscribers.get(channel);

    if (!subscribers) {
      subscribers = new Set();
      this.#channelSubscribers.set(channel, subscribers);
      await this.#sub.subscribe(channel);
    }
    subscribers.add(subscriber);

    return () => {
      const current = this.#channelSubscribers.get(channel);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) {
        this.#channelSubscribers.delete(channel);
        void this.#sub.unsubscribe(channel);
      }
    };
  }

  async requestCancel(runId: string, reason: string): Promise<void> {
    await this.#redis.publish(CONTROL_CHANNEL, JSON.stringify({ runId, reason }));
  }

  onCancelRequest(handler: (runId: string, reason: string) => void): void {
    this.#cancelHandlers.push(handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#sub.quit(), this.#redis.quit()]);
  }
}

function hashToRun(hash: Record<string, string>): Run {
  return {
    id: hash.id ?? '',
    goal: hash.goal ?? '',
    status: (hash.status ?? 'running') as Run['status'],
    createdAt: hash.createdAt ?? '',
    updatedAt: hash.updatedAt ?? '',
    idempotencyKey: hash.idempotencyKey ? hash.idempotencyKey : null,
  };
}
