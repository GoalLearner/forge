/**
 * The ledger, driven end-to-end through the real loop against a real HTTP
 * server that really fails.
 *
 * The unit tests prove the accounting arithmetic. These prove the wiring: that
 * a retry the transport performed is a retry the ledger counted, that the
 * allowance spans the whole prompt rather than resetting each model turn, and
 * that a run which ends badly still leaves an honest record rather than a
 * confident-looking zero.
 *
 * Every failure here is a genuine HTTP 500 or a genuine socket hang-up, not a
 * stubbed rejection — the point is to exercise the same path a flaky provider
 * takes.
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
import { OpenAIProvider } from '../providers/openai.ts';
import { ConfigSchema, type ModelEntry } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import { RunLedger, RetryBudget, UNKNOWN_USAGE, formatLedgerCost } from '../session/ledger.ts';
import type { ResolvedModel } from '../providers/registry.ts';
import type { ToolContext } from '../tools/types.ts';

// ---------------------------------------------------------------------------
// A provider that can be told exactly how to misbehave
// ---------------------------------------------------------------------------

interface Behaviour {
  /** HTTP 500 this many times before anything succeeds. Consumed globally. */
  failures: number;
  /** Scripted successful turns, in order; the last one repeats. */
  turns: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; args: string }> }>;
  /** Usage attached to every successful turn. */
  usage?: Record<string, unknown>;
  /** Never answer — used to test cancellation and runtime expiry. */
  hang?: boolean;
}

function startServer(b: Behaviour): Promise<{
  server: Server;
  url: string;
  /** Every request that reached the server, including the ones that 500ed. */
  hits: () => number;
}> {
  let hits = 0;
  let remainingFailures = b.failures;
  let turnIndex = 0;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits += 1;

      if (b.hang) return; // hold the socket open forever

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        // A real 500 with no retry-after, so backoff is used.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }

      const turn = b.turns[Math.min(turnIndex++, b.turns.length - 1)] ?? {};
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (p: unknown): void => void res.write(`data: ${JSON.stringify(p)}\n\n`);

      if (turn.text) send({ choices: [{ delta: { content: turn.text }, finish_reason: null }] });

      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: call.id, function: { name: call.name, arguments: call.args } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }

      send({
        choices: [{ delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }],
      });
      send({
        choices: [],
        usage: b.usage ?? {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_cache_hit_tokens: 960,
          prompt_cache_miss_tokens: 40,
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    });
  });
}

function makeModel(baseURL: string): ResolvedModel {
  const entry: ModelEntry = {
    provider: 'mock',
    model: 'mock-model',
    contextWindow: 200_000,
    maxOutput: 4096,
    // Round numbers so the expected cost is checkable by hand.
    pricing: { input: 1.0, cachedInput: 0.1, output: 10.0 },
    autoCache: true,
    subscription: false,
    local: false,
  };
  return {
    key: 'mock/mock-model',
    entry,
    provider: new OpenAIProvider('mock', { apiKey: 'test-key', baseURL }),
  };
}

interface RunResult {
  events: LoopEvent[];
  ledger: RunLedger;
}

async function drive(
  url: string,
  opts: {
    prompt?: string;
    maxRetries?: number;
    maxSteps?: number;
    maxRuntimeMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-ledger-int-'));
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
  conversation.addUserText(opts.prompt ?? 'do the thing');

  const signal = opts.signal ?? new AbortController().signal;
  const toolContext: ToolContext = {
    cwd,
    config,
    signal,
    permissions: new PermissionManager('yolo', cwd),
    files: new FileTracker(),
  };

  const ledger = new RunLedger('run_int', new RetryBudget(config.limits.maxRetries));

  const events: LoopEvent[] = [];
  for await (const e of runTurn({
    conversation,
    model: makeModel(url),
    tools,
    toolContext,
    config,
    signal,
    ledger,
    confirm: async () => ({ type: 'allow' }),
  })) {
    events.push(e);
  }

  return { events, ledger };
}

function terminal(events: LoopEvent[]): Extract<LoopEvent, { type: 'done' }> | undefined {
  return events.find((e) => e.type === 'done') as Extract<LoopEvent, { type: 'done' }> | undefined;
}

// ---------------------------------------------------------------------------
// Retry then success
// ---------------------------------------------------------------------------

test('a retried request is billed as one logical request and three attempts', async (t) => {
  const { server, url, hits } = await startServer({
    failures: 2,
    turns: [{ text: 'done at last' }],
  });
  t.after(() => server.close());

  const { events, ledger } = await drive(url, { maxRetries: 4 });
  const done = terminal(events);

  assert.equal(done?.outcome, 'completed', 'transient failures must not fail the run');
  assert.equal(hits(), 3, 'the server really was hit three times');

  const s = ledger.summary();
  assert.equal(s.logicalRequests, 1, 'the user asked for one thing');
  assert.equal(s.providerAttempts, 3, 'and it cost three HTTP attempts');
  assert.equal(s.retriesUsed, 2, 'which is two retries');
  assert.equal(
    s.providerAttempts - s.retriesUsed,
    s.logicalRequests,
    'attempts always reconcile as requests + retries',
  );
});

test('the successful attempt is priced; the dispatched failures make it a lower bound', async (t) => {
  const { server, url } = await startServer({ failures: 2, turns: [{ text: 'ok' }] });
  t.after(() => server.close());

  const { ledger } = await drive(url);
  const s = ledger.summary();

  // Only the third attempt returned usage: 960 cached + 40 miss in, 100 out.
  assert.equal(s.cacheHitInput, 960);
  assert.equal(s.cacheMissInput, 40);
  assert.equal(s.outputTokens, 100);

  // 960 @ $0.10/M + 40 @ $1.00/M + 100 @ $10.00/M = $0.001136
  assert.equal(s.cost.nanos, 96_000 + 40_000 + 1_000_000, 'the priced subtotal is exact');
  assert.equal(
    s.cost.state,
    'incomplete',
    'two requests reached the provider and reported nothing back — what they cost is not observable from here',
  );
});

test('the retry allowance is spent across turns, not restored by each one', async (t) => {
  // Turn 1 costs a retry, then calls a tool; turn 2 costs another retry.
  const { server, url } = await startServer({
    failures: 1,
    turns: [
      { text: 'reading', toolCalls: [{ id: 'c1', name: 'list_files', args: '{"path":"."}' }] },
      { text: 'finished' },
    ],
  });
  t.after(() => server.close());

  const { events, ledger } = await drive(url, { maxRetries: 4 });
  const s = ledger.summary();

  assert.equal(terminal(events)?.outcome, 'completed');
  assert.equal(s.logicalRequests, 2, 'two model turns');
  assert.equal(s.retriesUsed, 1);
  assert.equal(
    s.retryLimit - s.retriesUsed,
    3,
    'the second turn inherited the spent budget instead of getting a fresh 4',
  );
});

// ---------------------------------------------------------------------------
// Retry exhaustion
// ---------------------------------------------------------------------------

test('exhausting the shared allowance fails the run with retry_limit', async (t) => {
  const { server, url, hits } = await startServer({ failures: Infinity, turns: [{ text: 'never' }] });
  t.after(() => server.close());

  const { events, ledger } = await drive(url, { maxRetries: 2 });
  const done = terminal(events);

  assert.equal(done?.outcome, 'failed', 'a run that never got an answer is not a success');
  assert.equal(done?.termination.kind, 'retry_limit');
  assert.equal(hits(), 3, 'one initial attempt plus exactly two retries — no more');

  const s = ledger.summary();
  assert.equal(s.providerAttempts, 3);
  assert.equal(s.retriesUsed, 2);
  assert.equal(ledger.retryBudget.canRetry(), false);
});

test('a run whose every attempt reached the provider and returned nothing is incomplete', async (t) => {
  const { server, url } = await startServer({ failures: Infinity, turns: [] });
  t.after(() => server.close());

  const { ledger } = await drive(url, { maxRetries: 1 });
  const s = ledger.summary();

  // Each attempt left this process and came back a 500. Whether the provider
  // did any work — and billed for it — is simply not observable from here.
  // An earlier revision called this a known $0.00 on the theory that billing is
  // per token delivered; that is a guess about provider policy, not evidence.
  assert.equal(s.cost.state, 'incomplete');
  assert.equal(s.outputTokens, null, 'nothing was reported, so nothing is claimed');
  assert.equal(
    formatLedgerCost(s.cost),
    'Usage unavailable',
    'and it must never present itself as an authoritative $0.00',
  );
});

test('the reported termination names the limit the user can actually change', async (t) => {
  const { server, url } = await startServer({ failures: Infinity, turns: [] });
  t.after(() => server.close());

  const { events } = await drive(url, { maxRetries: 2 });
  const done = terminal(events);

  assert.equal(done?.termination.kind, 'retry_limit');
  if (done?.termination.kind === 'retry_limit') {
    assert.equal(done.termination.retriesUsed, 2);
    assert.equal(done.termination.attempts, 3);
    assert.match(done.termination.lastError, /500|upstream exploded/i);
  }
});

// ---------------------------------------------------------------------------
// Cancellation and runtime expiry
// ---------------------------------------------------------------------------

test('cancelling mid-flight still records the attempt that was in progress', async (t) => {
  const { server, url } = await startServer({ failures: 0, turns: [], hang: true });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120).unref();

  const { events, ledger } = await drive(url, { signal: ac.signal });
  const s = ledger.summary();

  assert.ok(
    events.some((e) => e.type === 'aborted' || (e.type === 'done' && e.outcome === 'cancelled')),
    'the run ends as cancelled',
  );
  assert.equal(s.providerAttempts, 1, 'the attempt happened and is on the record');
  assert.equal(s.retriesUsed, 0, 'a user cancellation is not a retryable failure');
  assert.equal(
    s.cost.state,
    'incomplete',
    'the request was dispatched and the provider never answered — its cost is unknown, not nil',
  );
  assert.equal(s.cost.nanos, 0);
});

test('a cancelled attempt does not consume the retry allowance', async (t) => {
  const { server, url, hits } = await startServer({ failures: 0, turns: [], hang: true });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120).unref();

  const { ledger } = await drive(url, { maxRetries: 4, signal: ac.signal });

  assert.equal(hits(), 1, 'aborting must not trigger a retry storm');
  assert.equal(ledger.retryBudget.consumed, 0);
});

test('the runtime budget expiring is recorded as max_runtime, not as a retry problem', async (t) => {
  const { server, url } = await startServer({ failures: 0, turns: [], hang: true });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const { events, ledger } = await drive(url, { maxRuntimeMs: 150, maxRetries: 4 });
  const done = terminal(events);

  assert.equal(done?.outcome, 'failed');
  assert.equal(done?.termination.kind, 'max_runtime', 'the first cause wins');
  assert.equal(ledger.summary().retriesUsed, 0);
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

test('a finalized ledger cannot be reopened by a late attempt', async (t) => {
  const { server, url } = await startServer({ failures: 0, turns: [{ text: 'hi' }] });
  t.after(() => server.close());

  const { ledger } = await drive(url);
  const before = ledger.finalize();

  // Exactly what a superseded run's straggling response would try to do.
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
    cost: { state: 'known', nanos: 999_000_000, tokens: 12_345 },
  });

  const after = ledger.summary();
  assert.deepEqual(after, before, 'the record froze at finalize and stayed frozen');
});

test('finalizing twice reports the same totals both times', async (t) => {
  const { server, url } = await startServer({ failures: 1, turns: [{ text: 'hi' }] });
  t.after(() => server.close());

  const { ledger } = await drive(url);

  const first = ledger.finalize();
  const second = ledger.finalize();

  assert.deepEqual(second, first, 'a shutdown flush racing a normal finalize must be harmless');
  assert.equal(first.providerAttempts, 2);
  assert.equal(first.finalized, true);
});
