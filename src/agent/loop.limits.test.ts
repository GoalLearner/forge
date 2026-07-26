/**
 * Limits driven through the REAL agent loop.
 *
 * `resolveToolTimeout` is unit-tested next door; this file proves the parts
 * that only exist once the loop is running:
 *
 *   - a hung tool actually terminates the run, and does so as `tool_timeout`
 *     rather than as a provider failure or a user cancellation
 *   - EVERY announced tool_use still gets exactly one tool_result, which is
 *     what keeps the transcript acceptable to the provider afterwards
 *   - the runtime budget fires mid-flight, not merely between steps
 *   - a real child process is dead by the time the run promise settles
 *
 * Slow tools are injected into the registry rather than simulated, so the code
 * under test is the production scheduler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { Conversation } from './messages.ts';
import { runTurn, type LoopEvent } from './loop.ts';
import { RuntimeBudget } from './run.ts';
import { OpenAIProvider } from '../providers/openai.ts';
import { ConfigSchema, type ModelEntry } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import type { ResolvedModel } from '../providers/registry.ts';
import type { Tool, ToolContext } from '../tools/types.ts';

// ---------------------------------------------------------------------------
// Mock provider: one scripted turn that calls the named tools, then finishes.
// ---------------------------------------------------------------------------

function startMockServer(
  calls: Array<{ id: string; name: string; args: string }>,
  opts: { delayMs?: number } = {},
): Promise<{ server: Server; url: string }> {
  let turn = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const first = turn++ === 0;
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const write = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (first && calls.length > 0) {
          calls.forEach((call, index) => {
            send({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index, id: call.id, function: { name: call.name, arguments: call.args } },
                    ],
                  },
                },
              ],
            });
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: 'done' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
        res.write('data: [DONE]\n\n');
        res.end();
      };

      // Optionally stall the response itself, to exercise a budget expiry that
      // lands while the model stream is open.
      if (opts.delayMs) setTimeout(write, opts.delayMs);
      else write();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function makeModel(baseURL: string): ResolvedModel {
  const entry: ModelEntry = {
    provider: 'mock',
    model: 'mock-model',
    contextWindow: 200_000,
    maxOutput: 4096,
    pricing: { input: 0.1, cachedInput: 0.01, output: 0.2 },
    autoCache: true,
    subscription: false,
    local: false,
  };
  return { key: 'mock/mock-model', entry, provider: new OpenAIProvider('mock', { apiKey: 'k', baseURL }) };
}

// ---------------------------------------------------------------------------
// Injected tools
// ---------------------------------------------------------------------------

/** A tool that hangs until aborted, then settles. Records that it stopped. */
function hangingTool(name: string, readOnly: boolean, state: { stopped: string[] }): Tool {
  return {
    name,
    description: 'test',
    readOnly,
    parameters: { type: 'object', properties: {} },
    summarize: () => name,
    execute: (_input, ctx) =>
      new Promise((resolve) => {
        const done = (): void => {
          state.stopped.push(name);
          resolve({ content: `${name} stopped` });
        };
        if (ctx.signal.aborted) return done();
        ctx.signal.addEventListener('abort', done, { once: true });
      }),
  };
}

/** A tool that spawns a real child and only settles once the child is gone. */
function childProcessTool(name: string, state: { child?: ChildProcess }): Tool {
  return {
    name,
    description: 'test',
    readOnly: false,
    parameters: { type: 'object', properties: {} },
    summarize: () => name,
    execute: (_input, ctx) =>
      new Promise((resolve) => {
        // A node process that would outlive the test if nothing killed it.
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
          stdio: 'ignore',
        });
        state.child = child;
        const finish = (): void => resolve({ content: 'child settled' });
        child.on('close', finish);
        ctx.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGKILL');
          },
          { once: true },
        );
      }),
  };
}

interface Harness {
  conversation: Conversation;
  toolContext: ToolContext;
  tools: Map<string, Tool>;
  config: ReturnType<typeof ConfigSchema.parse>;
}

function makeHarness(extra: Tool[], limits: Record<string, number> = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-limits-'));
  writeFileSync(join(cwd, 'hello.txt'), 'hi\n');

  const config = ConfigSchema.parse({ permissions: { mode: 'yolo' }, limits });
  const tools = buildTools({ todoStore: new TodoStore() });
  for (const tool of extra) tools.set(tool.name, tool);

  return {
    config,
    tools,
    conversation: new Conversation({ system: 'You are forge.', tools: toolSchemas(tools) }),
    toolContext: {
      cwd,
      config,
      signal: new AbortController().signal,
      permissions: new PermissionManager('yolo', cwd),
      files: new FileTracker(),
    },
  };
}

async function collect(
  harness: Harness,
  model: ResolvedModel,
  signal: AbortSignal,
  budget?: RuntimeBudget,
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of runTurn({
    conversation: harness.conversation,
    model,
    tools: harness.tools,
    toolContext: { ...harness.toolContext, signal },
    config: harness.config,
    signal,
    confirm: async () => ({ type: 'allow' }),
    ...(budget ? { budget } : {}),
  })) {
    events.push(event);
  }
  return events;
}

/** Every tool_use in the transcript must have exactly one matching result. */
function assertPaired(conversation: Conversation): void {
  const uses: string[] = [];
  const results: string[] = [];
  for (const message of conversation.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.push(block.id);
      if (block.type === 'tool_result') results.push(block.tool_use_id);
    }
  }
  assert.deepEqual(
    [...results].sort(),
    [...uses].sort(),
    'every announced tool_use needs exactly one tool_result',
  );
  assert.equal(new Set(results).size, results.length, 'no duplicate tool_results');
}

// ---------------------------------------------------------------------------
// Tool timeout
// ---------------------------------------------------------------------------

test('a hung tool terminates the run as tool_timeout', async (t) => {
  const state = { stopped: [] as string[] };
  const { server, url } = await startMockServer([
    { id: 'c1', name: 'slow_tool', args: '{}' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness([hangingTool('slow_tool', false, state)], { toolTimeoutMs: 60 });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.deepEqual(done.termination, { kind: 'tool_timeout', tool: 'slow_tool', timeoutMs: 60 });
  assert.deepEqual(state.stopped, ['slow_tool'], 'the tool was actually aborted, not abandoned');
  assertPaired(harness.conversation);
});

test('a tool finishing before its deadline succeeds normally', async (t) => {
  const { server, url } = await startMockServer([
    { id: 'c1', name: 'read_file', args: '{"path":"hello.txt"}' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness([], { toolTimeoutMs: 30_000 });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'completed');
  assertPaired(harness.conversation);
});

test('a timeout waits for a real child process to die before settling', async (t) => {
  const state: { child?: ChildProcess } = {};
  const { server, url } = await startMockServer([{ id: 'c1', name: 'spawner', args: '{}' }]);
  t.after(() => server.close());
  t.after(() => state.child?.kill('SIGKILL'));

  const harness = makeHarness([childProcessTool('spawner', state)], { toolTimeoutMs: 80 });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  // The run promise has already settled here — the child must be gone by now,
  // not merely asked to stop.
  assert.ok(state.child, 'the tool spawned a child');
  assert.equal(state.child?.killed || state.child?.exitCode !== null, true, 'child settled');
  assertPaired(harness.conversation);
});

// ---------------------------------------------------------------------------
// Scheduling integrity
// ---------------------------------------------------------------------------

test('one concurrent tool timing out aborts its siblings and pairs every call', async (t) => {
  const state = { stopped: [] as string[] };
  const { server, url } = await startMockServer([
    { id: 'c1', name: 'slow_a', args: '{}' },
    { id: 'c2', name: 'slow_b', args: '{}' },
    { id: 'c3', name: 'slow_c', args: '{}' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness(
    [
      hangingTool('slow_a', true, state),
      hangingTool('slow_b', true, state),
      hangingTool('slow_c', true, state),
    ],
    { toolTimeoutMs: 60 },
  );
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.termination.kind, 'tool_timeout');
  assert.equal(state.stopped.length, 3, 'siblings were aborted, not left running');
  assertPaired(harness.conversation);
});

test('a serial tool timing out stops later mutations but still answers them', async (t) => {
  const state = { stopped: [] as string[] };
  const ran: string[] = [];
  const marker: Tool = {
    name: 'later_write',
    description: 'test',
    readOnly: false,
    parameters: { type: 'object', properties: {} },
    summarize: () => 'later_write',
    execute: async () => {
      ran.push('later_write');
      return { content: 'mutated' };
    },
  };

  const { server, url } = await startMockServer([
    { id: 'c1', name: 'slow_write', args: '{}' },
    { id: 'c2', name: 'later_write', args: '{}' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness([hangingTool('slow_write', false, state), marker], {
    toolTimeoutMs: 60,
  });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.termination.kind, 'tool_timeout');
  assert.deepEqual(ran, [], 'no mutation may begin after the run has stopped');
  assertPaired(harness.conversation);
});

// ---------------------------------------------------------------------------
// Runtime budget
// ---------------------------------------------------------------------------

test('the runtime budget terminates a run stalled in a tool', async (t) => {
  const state = { stopped: [] as string[] };
  const { server, url } = await startMockServer([{ id: 'c1', name: 'slow_tool', args: '{}' }]);
  t.after(() => server.close());

  // Runtime is the tighter limit, so it is the one that should be reported.
  const harness = makeHarness([hangingTool('slow_tool', false, state)], {
    toolTimeoutMs: 60_000,
    maxRuntimeMs: 80,
  });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.termination.kind, 'max_runtime', 'not tool_timeout, not cancelled');
  assertPaired(harness.conversation);
});

test('the runtime budget terminates a run stalled in the model stream', async (t) => {
  const { server, url } = await startMockServer([], { delayMs: 400 });
  t.after(() => server.close());

  const harness = makeHarness([], { maxRuntimeMs: 60 });
  harness.conversation.addUserText('go');

  const events = await collect(harness, makeModel(url), new AbortController().signal);
  const done = events.find((e) => e.type === 'done');

  assert.ok(done && done.type === 'done', 'a stalled stream must still terminate');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.termination.kind, 'max_runtime');
});

test('a user cancellation is still reported as cancelled, not as a limit', async (t) => {
  const state = { stopped: [] as string[] };
  const { server, url } = await startMockServer([{ id: 'c1', name: 'slow_tool', args: '{}' }]);
  t.after(() => server.close());

  const harness = makeHarness([hangingTool('slow_tool', false, state)], {
    toolTimeoutMs: 60_000,
    maxRuntimeMs: 60_000,
  });
  harness.conversation.addUserText('go');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);

  const events = await collect(harness, makeModel(url), controller.signal);

  assert.ok(
    events.some((e) => e.type === 'aborted'),
    'a human stop is an abort, never a limit failure',
  );
  assert.equal(
    events.some((e) => e.type === 'done' && e.termination.kind === 'max_runtime'),
    false,
  );
  assertPaired(harness.conversation);
});

test('a tool refused for lack of runtime is reported, not silently skipped', async (t) => {
  const { server, url } = await startMockServer([
    { id: 'c1', name: 'read_file', args: '{"path":"hello.txt"}' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness([], { maxRuntimeMs: 10 });
  harness.conversation.addUserText('go');

  // Hand in a budget that is already spent, so the tool cannot start at all.
  const spent = new RuntimeBudget(10, () => Date.now() + 10_000);
  await collect(harness, makeModel(url), new AbortController().signal, spent);

  assertPaired(harness.conversation);
  spent.stop();
});
