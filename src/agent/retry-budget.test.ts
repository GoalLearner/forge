/**
 * The aggregate retry contract, driven through the production loop.
 *
 * The defect this fixes: `maxRetries` was handed to `withRetry` on every model
 * turn, so the allowance RESET each turn. A 30-turn tool-using run could
 * legitimately make 30 × (1 + maxRetries) paid provider attempts, and nothing
 * in the UI or the config suggested that was possible. The budget is now one
 * object per submitted prompt.
 *
 * Every test here drives `runTurn` against a scripted HTTP server, so the
 * attempt counting is real network behaviour rather than a simulation.
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
import { RetryBudget, RunLedger } from '../session/ledger.ts';
import { RunCancelledError } from './run.ts';
import { ConfigSchema, type ModelEntry } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import type { ResolvedModel } from '../providers/registry.ts';

const ENTRY: ModelEntry = {
  provider: 'mock',
  model: 'mock-model',
  contextWindow: 200_000,
  maxOutput: 4096,
  pricing: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  autoCache: true,
  subscription: false,
  local: false,
};

/**
 * A server whose per-call behaviour is scripted.
 *
 * `plan` is consumed one entry per HTTP request, so "fail, fail, succeed" is
 * expressed directly and the number of ACTUAL outbound attempts is observable
 * as `calls.length`.
 */
type Step =
  | { kind: 'ok'; text?: string; tool?: boolean; usage?: Record<string, unknown> }
  | { kind: 'retryable'; status?: number }
  | { kind: 'fatal'; status?: number };

function startServer(plan: Step[]): Promise<{ server: Server; url: string; calls: number[] }> {
  const calls: number[] = [];
  let i = 0;

  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const step = plan[Math.min(i, plan.length - 1)] ?? { kind: 'ok' as const };
      i += 1;
      calls.push(Date.now());

      if (step.kind === 'retryable') {
        res.writeHead(step.status ?? 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream busy' } }));
        return;
      }
      if (step.kind === 'fatal') {
        res.writeHead(step.status ?? 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (p: unknown): void => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      };
      if (step.tool) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: `c${i}`, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: step.text ?? 'done' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      send({
        choices: [],
        usage: step.usage ?? {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 60,
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
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

interface RunResult {
  events: LoopEvent[];
  ledger: RunLedger;
  calls: number;
}

async function drive(
  plan: Step[],
  opts: { maxRetries: number; signal?: AbortSignal; ledger?: RunLedger; maxRuntimeMs?: number } ,
  t: { after: (fn: () => void) => void },
): Promise<RunResult> {
  const { server, url, calls } = await startServer(plan);
  t.after(() => server.close());

  const cwd = mkdtempSync(join(tmpdir(), 'forge-retry-'));
  const config = ConfigSchema.parse({
    permissions: { mode: 'yolo' },
    limits: { maxRetries: opts.maxRetries, ...(opts.maxRuntimeMs ? { maxRuntimeMs: opts.maxRuntimeMs } : {}) },
  });
  const tools = buildTools({ todoStore: new TodoStore() });
  const conversation = new Conversation({ system: 'sys', tools: toolSchemas(tools) });
  conversation.addUserText('go');

  const ledger = opts.ledger ?? new RunLedger('run_test', new RetryBudget(opts.maxRetries));
  const model: ResolvedModel = {
    key: 'mock/mock-model',
    entry: ENTRY,
    provider: new OpenAIProvider('mock', { apiKey: 'k', baseURL: url }),
  };

  const events: LoopEvent[] = [];
  for await (const e of runTurn({
    conversation,
    model,
    tools,
    toolContext: {
      cwd,
      config,
      signal: opts.signal ?? new AbortController().signal,
      permissions: new PermissionManager('yolo', cwd),
      files: new FileTracker(),
    },
    config,
    signal: opts.signal ?? new AbortController().signal,
    confirm: async () => ({ type: 'allow' }),
    ledger,
  })) {
    events.push(e);
  }

  return { events, ledger, calls: calls.length };
}

const doneEvent = (r: RunResult): Extract<LoopEvent, { type: 'done' }> | undefined =>
  r.events.find((e): e is Extract<LoopEvent, { type: 'done' }> => e.type === 'done');

// ---------------------------------------------------------------------------

test('the retry budget is SHARED across model turns and does not reset', async (t) => {
  // maxRetries = 2. Each logical request fails once then succeeds, so the old
  // per-request behaviour would have allowed this to continue indefinitely.
  const r = await drive(
    [
      { kind: 'retryable' },            // request 1, attempt 1  → retry #1
      { kind: 'ok', tool: true },       // request 1, attempt 2  ✓
      { kind: 'retryable' },            // request 2, attempt 1  → retry #2
      { kind: 'ok', tool: true },       // request 2, attempt 2  ✓
      { kind: 'retryable' },            // request 3, attempt 1  → budget spent
    ],
    { maxRetries: 2 },
    t,
  );

  const done = doneEvent(r);
  assert.ok(done);
  assert.equal(done.outcome, 'failed');
  assert.equal(done.termination.kind, 'retry_limit', 'not max_steps, not provider_error');
  assert.equal(r.ledger.retryBudget.consumed, 2, 'the counter never reset between turns');
  assert.equal(r.ledger.retryBudget.remaining, 0);

  // 5 outbound attempts: 2+2 for the first two requests, 1 for the third. The
  // decisive assertion — no SIXTH attempt was dispatched after exhaustion.
  assert.equal(r.calls, 5, 'no attempt is sent once the budget is spent');
});

test('a new run receives a fresh allowance', async (t) => {
  const first = await drive(
    [{ kind: 'retryable' }, { kind: 'retryable' }, { kind: 'retryable' }],
    { maxRetries: 2 },
    t,
  );
  assert.equal(first.ledger.retryBudget.remaining, 0);

  const second = await drive([{ kind: 'ok' }], { maxRetries: 2 }, t);
  assert.equal(second.ledger.retryBudget.limit, 2);
  assert.equal(second.ledger.retryBudget.consumed, 0, 'a new prompt starts clean');
  assert.equal(doneEvent(second)?.outcome, 'completed');
});

test('initial attempts never consume retry units', async (t) => {
  const r = await drive([{ kind: 'ok', tool: true }, { kind: 'ok' }], { maxRetries: 2 }, t);
  assert.equal(doneEvent(r)?.outcome, 'completed');
  assert.equal(r.ledger.retryBudget.consumed, 0, 'two clean turns cost no retries');
  assert.equal(r.calls, 2);
  assert.equal(r.ledger.summary().logicalRequests, 2, 'tool follow-up is a NEW request');
});

test('a non-retryable failure is not retried and spends nothing', async (t) => {
  const r = await drive([{ kind: 'fatal', status: 400 }], { maxRetries: 3 }, t);
  assert.equal(r.calls, 1, 'a 400 will fail identically next time');
  assert.equal(r.ledger.retryBudget.consumed, 0);
  assert.ok(r.events.some((e) => e.type === 'error'));
});

test('retry exhaustion is reported as retry_limit, keeping the provider error', async (t) => {
  const r = await drive([{ kind: 'retryable', status: 503 }], { maxRetries: 1 }, t);
  const done = doneEvent(r);
  assert.ok(done);
  assert.equal(done.termination.kind, 'retry_limit');
  if (done.termination.kind === 'retry_limit') {
    assert.equal(done.termination.retriesUsed, 1);
    assert.match(done.termination.lastError, /503|busy/i, 'the real failure is preserved');
  }
  assert.equal(r.calls, 2, 'exactly 1 + maxRetries attempts');
});

test('a zero budget means one attempt and no retry', async (t) => {
  const r = await drive([{ kind: 'retryable' }], { maxRetries: 0 }, t);
  assert.equal(r.calls, 1);
  assert.equal(doneEvent(r)?.termination.kind, 'retry_limit');
});

test('cancellation during backoff dispatches nothing further and wins', async (t) => {
  const controller = new AbortController();
  // Abort while the loop is sleeping between attempts.
  setTimeout(() => controller.abort(new RunCancelledError('user')), 60);

  const r = await drive(
    [{ kind: 'retryable' }, { kind: 'retryable' }, { kind: 'retryable' }, { kind: 'ok' }],
    { maxRetries: 5, signal: controller.signal },
    t,
  );

  assert.ok(
    r.events.some((e) => e.type === 'aborted'),
    'cancellation wins over the retry machinery',
  );
  assert.equal(
    r.events.some((e) => e.type === 'done' && e.termination.kind === 'retry_limit'),
    false,
    'a cancelled run is not a retry-limit failure',
  );
  assert.ok(r.calls < 5, 'the remaining attempts were never sent');
});

test('runtime expiry during backoff wins over retry_limit', async (t) => {
  const r = await drive(
    [{ kind: 'retryable' }, { kind: 'retryable' }, { kind: 'retryable' }, { kind: 'retryable' }],
    { maxRetries: 5, maxRuntimeMs: 120 },
    t,
  );

  const done = doneEvent(r);
  assert.ok(done);
  assert.equal(done.termination.kind, 'max_runtime', 'the first cause wins, not the retry counter');
});

test('adapters cannot perform uncounted retries of their own', async (t) => {
  // Both SDK clients are constructed with maxRetries: 0 so every attempt passes
  // through the shared budget. If an adapter retried internally, `calls` would
  // exceed 1 + maxRetries here.
  const r = await drive([{ kind: 'retryable' }, { kind: 'retryable' }], { maxRetries: 1 }, t);
  assert.equal(r.calls, 2, 'exactly the attempts the budget authorised — no hidden extras');
});

// --- ledger integration ----------------------------------------------------

test('every dispatched attempt appears in the ledger, retries included', async (t) => {
  const r = await drive(
    [{ kind: 'retryable' }, { kind: 'ok', tool: true }, { kind: 'ok' }],
    { maxRetries: 2 },
    t,
  );

  const attempts = r.ledger.allAttempts();
  assert.equal(attempts.length, 3, 'the failed attempt is not forgotten');
  assert.equal(r.calls, 3);

  const reqs = r.ledger.requestSummaries();
  assert.equal(reqs.length, 2, 'two logical requests');
  assert.deepEqual(reqs.map((q) => q.attempts), [2, 1]);
  assert.deepEqual(reqs.map((q) => q.retries), [1, 0]);
});

test('a successful run aggregates cost across both model turns', async (t) => {
  const r = await drive([{ kind: 'ok', tool: true }, { kind: 'ok' }], { maxRetries: 2 }, t);
  const s = r.ledger.summary();

  assert.equal(s.providerAttempts, 2);
  // The mock speaks DeepSeek's dialect: it reports the cache hit AND the miss,
  // so no count is inferred and the figure rests entirely on provider numbers.
  assert.equal(s.cost.state, 'known', 'every pricing input was reported, none derived');
  assert.ok(s.cost.nanos > 0);
  assert.equal(s.cacheHitInput, 120, '60 per turn, reported by the provider');
  assert.equal(s.cacheMissInput, 80);
  assert.equal(s.outputTokens, 40);
  assert.equal(s.reasoningTokens, null, 'the mock reports none — stays unknown, not 0');
});

test('a retried attempt does not make the run cost untrustworthy', async (t) => {
  const r = await drive([{ kind: 'retryable' }, { kind: 'ok' }], { maxRetries: 2 }, t);
  const s = r.ledger.summary();

  assert.equal(s.providerAttempts, 2);
  // Retries only happen before the first stream event, so the failed attempt
  // provably delivered no tokens and cannot have been billed. Marking the run
  // untrustworthy over a routine 429 would make the confidence label fire
  // constantly and mean nothing when it mattered.
  assert.equal(s.cost.state, 'known', 'the failure contributed a certain zero');
  assert.ok(s.cost.nanos > 0, 'and the successful attempt contributed the actual charge');
});

test('finalization is idempotent and freezes the ledger', async (t) => {
  const r = await drive([{ kind: 'ok' }], { maxRetries: 2 }, t);
  const a = r.ledger.finalize();
  const b = r.ledger.finalize();
  assert.equal(a.providerAttempts, b.providerAttempts);
  assert.equal(a.cost.nanos, b.cost.nanos);
  assert.equal(b.finalized, true);
});
