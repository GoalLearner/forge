/**
 * The Step 4B-Fix accounting contract, driven end-to-end.
 *
 * Three corrections are locked in here, each of which had shipped the wrong way
 * round and each of which is invisible unless a real request really fails:
 *
 *   1. Money Forge calculates is an ESTIMATE, however exactly the provider
 *      reported the token counts. `known` is reserved for a quoted amount, or
 *      for a call that was never made.
 *   2. Once a request has left this process, its cost is UNKNOWN unless the
 *      provider says otherwise. "Nothing streamed back" is not proof of "no
 *      charge" — it is the absence of evidence, and it used to be displayed as
 *      an authoritative $0.00.
 *   3. One dispatch produces exactly one ledger row. A cancellation landing
 *      during retry backoff previously produced two rows for one HTTP request,
 *      because the retry callback and the catch block each recorded it.
 *
 * Everything below therefore counts real HTTP requests on one side and ledger
 * rows on the other, and asserts they agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { Conversation } from './messages.ts';
import { runTurn, type LoopEvent } from './loop.ts';
import { RunCancelledError } from './run.ts';
import { OpenAIProvider } from '../providers/openai.ts';
import { ConfigSchema, type ModelEntry } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import {
  RunLedger,
  RetryBudget,
  NO_BILLABLE_USAGE,
  UNKNOWN_USAGE,
  formatLedgerCost,
  priceUsage,
  snapshotPricing,
  type ProviderAttempt,
} from '../session/ledger.ts';
import type { ResolvedModel } from '../providers/registry.ts';
import type { ToolContext } from '../tools/types.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Round rates so every expected figure below is checkable by hand. */
const ENTRY: ModelEntry = {
  provider: 'mock',
  model: 'mock-model',
  contextWindow: 200_000,
  maxOutput: 4096,
  pricing: { input: 1.0, cachedInput: 0.1, output: 10.0 },
  autoCache: true,
  subscription: false,
  local: false,
};

/** DeepSeek's dialect: cache hit AND miss both stated outright. */
const DEEPSEEK_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_cache_hit_tokens: 960,
  prompt_cache_miss_tokens: 40,
};
// 960 @ $0.1/M + 40 @ $1/M + 100 @ $10/M
const EXPECTED_NANOS = 96_000 + 40_000 + 1_000_000;

type Handler = (res: import('node:http').ServerResponse) => void;

async function serve(handler: Handler): Promise<{
  url: string;
  hits: () => number;
  close: () => void;
  server: Server;
}> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits += 1;
      handler(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    server,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/**
 * Write an SSE response. `close` finishes it the way a real provider does;
 * leaving it open is how the mid-stream-failure cases hold the socket until
 * they destroy it.
 */
function sse(
  res: import('node:http').ServerResponse,
  parts: unknown[],
  close: boolean = false,
): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const p of parts) res.write(`data: ${JSON.stringify(p)}\n\n`);
  if (close) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/** A complete, well-behaved response. */
function ok(res: import('node:http').ServerResponse): void {
  sse(res, OK_STREAM, true);
}

const OK_STREAM: unknown[] = [
  { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: DEEPSEEK_USAGE },
];

interface DriveResult {
  events: LoopEvent[];
  ledger: RunLedger;
  rows: readonly ProviderAttempt[];
  done: Extract<LoopEvent, { type: 'done' }> | undefined;
  aborted: boolean;
}

async function drive(
  url: string,
  opts: {
    maxRetries?: number;
    maxSteps?: number;
    maxRuntimeMs?: number;
    controller?: AbortController;
  } = {},
): Promise<DriveResult> {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-contract-'));
  const config = ConfigSchema.parse({
    permissions: { mode: 'yolo' },
    limits: {
      maxRetries: opts.maxRetries ?? 4,
      maxSteps: opts.maxSteps ?? 8,
      ...(opts.maxRuntimeMs ? { maxRuntimeMs: opts.maxRuntimeMs } : {}),
    },
  });
  const tools = buildTools({ todoStore: new TodoStore() });
  const conversation = new Conversation({ system: 'You are forge.', tools: toolSchemas(tools) });
  conversation.addUserText('do the thing');

  const ac = opts.controller ?? new AbortController();
  const ledger = new RunLedger('run_contract', new RetryBudget(config.limits.maxRetries));
  const model: ResolvedModel = {
    key: 'mock/mock-model',
    entry: ENTRY,
    provider: new OpenAIProvider('mock', { apiKey: 'test-key', baseURL: url }),
  };

  const toolContext: ToolContext = {
    cwd,
    config,
    signal: ac.signal,
    permissions: new PermissionManager('yolo', cwd),
    files: new FileTracker(),
  };

  const events: LoopEvent[] = [];
  for await (const e of runTurn({
    conversation,
    model,
    tools,
    toolContext,
    config,
    signal: ac.signal,
    ledger,
    confirm: async () => ({ type: 'allow' }),
  })) {
    events.push(e);
  }

  return {
    events,
    ledger,
    rows: ledger.allAttempts(),
    done: events.find((e) => e.type === 'done') as DriveResult['done'],
    aborted: events.some((e) => e.type === 'aborted'),
  };
}

// ---------------------------------------------------------------------------
// Cost confidence — locally calculated money is an estimate
// ---------------------------------------------------------------------------

test('DeepSeek-reported counts priced locally are estimated, not known', async (t) => {
  const s = await serve((res) => ok(res));
  t.after(s.close);

  const { ledger } = await drive(s.url);
  const cost = ledger.summary().cost;

  assert.equal(cost.nanos, EXPECTED_NANOS, 'the arithmetic is exact');
  assert.equal(
    cost.state,
    'estimated',
    'every token count was reported, but the dollars came from models.json',
  );
});

test('the OpenAI dialect prices to the same number and the same confidence', async (t) => {
  // Same totals, expressed the other way: a total plus a cached subset, so the
  // cache-miss is Forge's subtraction. The DOLLARS are equally local either
  // way, which is the whole point — provenance of counts must not change the
  // confidence of a locally computed amount.
  const s = await serve((res) =>
    sse(res, [
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 960 },
        },
      },
    ], true),
  );
  t.after(s.close);

  const { ledger } = await drive(s.url);
  const cost = ledger.summary().cost;

  assert.equal(cost.nanos, EXPECTED_NANOS, 'identical money');
  assert.equal(cost.state, 'estimated', 'identical confidence');
});

test('no positive locally calculated cost can come back known', () => {
  const pricing = snapshotPricing('mock/mock-model', ENTRY);
  const reported = {
    cacheHitInput: 960,
    cacheMissInput: 40,
    cacheWriteInput: null,
    totalInput: 1000,
    outputTokens: 100,
    reasoningTokens: null,
    sources: {
      cacheHitInput: 'reported' as const,
      cacheMissInput: 'reported' as const,
      outputTokens: 'reported' as const,
      reasoningTokens: 'unknown' as const,
    },
    complete: true,
  };

  const cost = priceUsage(reported, pricing);
  assert.ok(cost.nanos > 0);
  assert.notEqual(cost.state, 'known', 'the only known cost is one nobody had to calculate');
  assert.equal(cost.state, 'estimated');
});

test('a call that was never made is a known zero', () => {
  const pricing = snapshotPricing('mock/mock-model', ENTRY);
  const cost = priceUsage(NO_BILLABLE_USAGE, pricing);

  assert.equal(NO_BILLABLE_USAGE.provenNoDispatch, true);
  assert.equal(cost.state, 'known', 'nothing was sent, so nothing can be owed');
  assert.equal(cost.nanos, 0);
});

test('the displayed figure says it is an estimate', async (t) => {
  const s = await serve((res) => ok(res));
  t.after(s.close);

  const { ledger } = await drive(s.url);
  assert.match(formatLedgerCost(ledger.summary().cost), /estimated$/);
});

// ---------------------------------------------------------------------------
// Dispatched, nothing returned — unknown, never free
// ---------------------------------------------------------------------------

const DISPATCHED_FAILURES: Array<{ label: string; handler: Handler; streams: boolean }> = [
  {
    label: 'HTTP 429',
    handler: (res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    },
    streams: false,
  },
  {
    label: 'HTTP 503',
    handler: (res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unavailable' } }));
    },
    streams: false,
  },
  {
    label: 'connection reset before the first stream event',
    handler: (res) => res.socket?.destroy(),
    streams: false,
  },
  {
    label: 'stream begins, then the connection dies',
    handler: (res) => {
      sse(res, [{ choices: [{ delta: { content: 'par' }, finish_reason: null }] }]);
      setTimeout(() => res.socket?.destroy(), 20);
    },
    streams: true,
  },
];

for (const c of DISPATCHED_FAILURES) {
  test(`${c.label}: dispatched with no usage is incomplete, never $0.00`, async (t) => {
    const s = await serve(c.handler);
    t.after(s.close);

    // maxRetries 0 keeps it to a single dispatch so the row maps 1:1.
    const { ledger } = await drive(s.url, { maxRetries: 0 });
    const summary = ledger.summary();
    const [row] = ledger.allAttempts();

    assert.equal(s.hits(), 1, 'the request really did leave this process');
    assert.equal(summary.providerAttempts, 1);
    assert.equal(row?.dispatched, true, 'and the record says so');
    assert.equal(row?.streamStarted, c.streams, 'streamStarted reflects the stream, not dispatch');
    assert.equal(row?.streamCompleted, false);

    assert.equal(summary.cost.state, 'incomplete');
    assert.notEqual(
      formatLedgerCost(summary.cost),
      '$0.00',
      'presenting an unknowable cost as zero is the defect this replaces',
    );
  });
}

test('a failure that never left the process is the one provable zero', () => {
  // Recorded directly: the loop marks dispatch before the outbound call, so the
  // only way to reach this state in production is a failure ahead of that
  // boundary. The contract for it is asserted here rather than simulated.
  const ledger = new RunLedger('run_predispatch', new RetryBudget(2));
  const pricing = snapshotPricing('mock/mock-model', ENTRY);
  ledger.beginRequest();
  ledger.recordAttempt({
    retryIndex: 0,
    provider: 'mock',
    requestedModel: 'mock/mock-model',
    returnedModel: null,
    startedAt: 0,
    endedAt: 1,
    durationMs: null,
    dispatched: false,
    streamStarted: false,
    streamCompleted: false,
    outcome: 'not_dispatched',
    retryable: null,
    errorCategory: 'validation',
    errorMessage: 'rejected before sending',
    retryDelayMs: null,
    usage: NO_BILLABLE_USAGE,
    pricing,
    cost: priceUsage(NO_BILLABLE_USAGE, pricing),
  });

  const [row] = ledger.allAttempts();
  assert.equal(row?.dispatched, false);
  assert.equal(row?.streamStarted, false);
  assert.equal(row?.cost.state, 'known');
  assert.equal(row?.cost.nanos, 0);
  assert.equal(ledger.summary().outputTokens, 0, 'a real zero, not a fabricated count');
});

test('a run aborted before it starts issues no request and records no attempt', async (t) => {
  const s = await serve((res) => ok(res));
  t.after(s.close);

  const ac = new AbortController();
  ac.abort(new RunCancelledError('user'));
  const { ledger } = await drive(s.url, { controller: ac });

  assert.equal(s.hits(), 0, 'nothing was sent');
  assert.equal(ledger.summary().providerAttempts, 0, 'so there is no attempt to describe');
});

// ---------------------------------------------------------------------------
// Usage observed before a later failure is kept
// ---------------------------------------------------------------------------

test('usage reported before a stream failure survives as a priced lower bound', async (t) => {
  const s = await serve((res) => {
    sse(res, [
      { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
      { choices: [], usage: DEEPSEEK_USAGE },
    ]);
    // Dies before finish_reason and before [DONE].
    setTimeout(() => res.socket?.destroy(), 20);
  });
  t.after(s.close);

  const { ledger } = await drive(s.url, { maxRetries: 0 });
  const summary = ledger.summary();

  assert.equal(summary.cacheHitInput, 960, 'the numbers the provider sent are kept');
  assert.equal(summary.outputTokens, 100);
  assert.equal(summary.cost.nanos, EXPECTED_NANOS, 'and they are priced');
  assert.equal(
    summary.cost.state,
    'incomplete',
    'the attempt still failed, so more unreported work may have been billed',
  );
  assert.match(formatLedgerCost(summary.cost), /^At least /);
});

test('usage seen before a failure is counted once, not once per path', async (t) => {
  const s = await serve((res) => {
    sse(res, [
      { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
      { choices: [], usage: DEEPSEEK_USAGE },
    ]);
    setTimeout(() => res.socket?.destroy(), 20);
  });
  t.after(s.close);

  const { ledger } = await drive(s.url, { maxRetries: 0 });
  const summary = ledger.summary();

  assert.equal(summary.providerAttempts, 1);
  assert.equal(summary.outputTokens, 100, 'not 200 — the usage event is emitted on one path only');
  assert.equal(summary.cost.nanos, EXPECTED_NANOS);
});

// ---------------------------------------------------------------------------
// Exactly one row per dispatch
// ---------------------------------------------------------------------------

test('one dispatched request produces exactly one row', async (t) => {
  const s = await serve((res) => ok(res));
  t.after(s.close);

  const { ledger } = await drive(s.url);
  assert.equal(s.hits(), 1);
  assert.equal(ledger.summary().providerAttempts, 1);
});

test('a retry then a success is two dispatches and two distinct rows', async (t) => {
  let n = 0;
  const s = await serve((res) => {
    if (n++ === 0) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    ok(res);
  });
  t.after(s.close);

  const { ledger, done } = await drive(s.url, { maxRetries: 4 });
  const summary = ledger.summary();
  const rows = ledger.allAttempts();

  assert.equal(done?.outcome, 'completed');
  assert.equal(s.hits(), 2);
  assert.equal(summary.providerAttempts, 2);
  assert.equal(summary.logicalRequests, 1, 'a retry is not a new logical request');
  assert.equal(summary.retriesUsed, 1);

  // Two genuinely different attempts must never be collapsed into one.
  assert.deepEqual(
    rows.map((r) => r.attemptIndex),
    [1, 2],
    'de-duplication must not merge distinct attempts',
  );
  assert.deepEqual(
    rows.map((r) => r.retryIndex),
    [0, 1],
  );
  assert.deepEqual(rows.map((r) => r.outcome), ['retryable_error', 'success']);
});

test('the attempt that exhausts the allowance is recorded like any other', async (t) => {
  const s = await serve((res) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  t.after(s.close);

  const { ledger, done } = await drive(s.url, { maxRetries: 4 });
  const summary = ledger.summary();

  assert.equal(s.hits(), 5, 'one initial attempt plus exactly four retries');
  assert.equal(summary.providerAttempts, 5, 'every one of them is on the record');
  assert.equal(summary.retriesUsed, 4);
  assert.equal(done?.termination.kind, 'retry_limit');
  assert.equal(
    ledger.allAttempts().filter((r) => r.outcome === 'retryable_error').length,
    5,
    'including the final one, for which no retry callback ever fires',
  );
});

test('cancelling during retry backoff adds no phantom attempt and charges no retry', async (t) => {
  // retry-after: 3 guarantees the cancellation lands squarely inside the wait.
  const s = await serve((res) => {
    res.writeHead(503, { 'retry-after': '3' });
    res.end(JSON.stringify({ error: { message: 'unavailable' } }));
  });
  t.after(s.close);

  const ac = new AbortController();
  setTimeout(() => ac.abort(new RunCancelledError('user')), 300).unref();

  const { ledger, aborted } = await drive(s.url, { maxRetries: 4, controller: ac });
  const summary = ledger.summary();

  assert.ok(aborted, 'the run ends cancelled');
  assert.equal(s.hits(), 1, 'exactly one request was ever sent');
  assert.equal(
    summary.providerAttempts,
    1,
    'and exactly one row describes it — the retry callback and the catch block used to both record it',
  );
  assert.equal(
    summary.retriesUsed,
    0,
    'the retry was never dispatched, so its unit was never spent',
  );
});

test('runtime expiry during retry backoff behaves identically and keeps its reason', async (t) => {
  const s = await serve((res) => {
    res.writeHead(503, { 'retry-after': '3' });
    res.end(JSON.stringify({ error: { message: 'unavailable' } }));
  });
  t.after(s.close);

  const { ledger, done } = await drive(s.url, { maxRetries: 4, maxRuntimeMs: 400 });
  const summary = ledger.summary();

  assert.equal(done?.outcome, 'failed');
  assert.equal(done?.termination.kind, 'max_runtime', 'the first cause still wins');
  assert.equal(s.hits(), 1);
  assert.equal(summary.providerAttempts, 1);
  assert.equal(summary.retriesUsed, 0);
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('a second run starts with an empty ledger and a full allowance', async (t) => {
  const s = await serve((res) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  t.after(s.close);

  const first = await drive(s.url, { maxRetries: 2 });
  assert.equal(first.ledger.summary().retriesUsed, 2, 'the first run spent its allowance');

  const hitsAfterFirst = s.hits();
  const second = await drive(s.url, { maxRetries: 2 });
  const summary = second.ledger.summary();

  assert.equal(summary.retriesUsed, 2, 'the second run got its own, not the leftovers');
  assert.equal(summary.providerAttempts, 3);
  assert.equal(
    s.hits() - hitsAfterFirst,
    3,
    'and really did dispatch a fresh initial attempt plus two retries',
  );
});

test('a finalized ledger ignores a late attempt from a superseded run', async (t) => {
  const s = await serve((res) => ok(res));
  t.after(s.close);

  const { ledger } = await drive(s.url);
  const frozen = ledger.finalize();

  ledger.beginRequest();
  ledger.recordAttempt({
    retryIndex: 0,
    provider: 'mock',
    requestedModel: 'mock/mock-model',
    returnedModel: null,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    dispatched: true,
    streamStarted: true,
    streamCompleted: true,
    outcome: 'success',
    retryable: null,
    errorCategory: null,
    errorMessage: null,
    retryDelayMs: null,
    usage: UNKNOWN_USAGE,
    pricing: null,
    cost: { state: 'known', nanos: 999_000_000, tokens: 1 },
  });

  assert.deepEqual(ledger.summary(), frozen, 'the record froze and stayed frozen');
});
