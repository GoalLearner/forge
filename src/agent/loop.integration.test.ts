/**
 * End-to-end test of the agent loop against a mock OpenAI-compatible server.
 *
 * This is the closest thing to "does forge actually work" that runs without an
 * API key, and it exercises the parts most likely to break silently:
 *
 *   - SSE stream parsing and tool-call fragment reassembly
 *   - repair of malformed tool arguments mid-stream
 *   - the permission gate (allow and deny paths)
 *   - real tool execution against a real temp directory
 *   - tool results appended as ONE message
 *   - usage normalization, including DeepSeek's cache-hit dialect
 *   - the multi-turn loop terminating when the model stops calling tools
 *
 * The mock server deliberately emits tool arguments split across chunk
 * boundaries mid-token, which is what real providers do and what naive
 * accumulation gets wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
import type { ResolvedModel } from '../providers/registry.ts';
import type { PermissionDecision, PermissionRequest, ToolContext } from '../tools/types.ts';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  usage?: Record<string, unknown>;
  /** Override the finish reason, to exercise `length` / `content_filter`. */
  finishReason?: string;
  /**
   * Close the stream without ever sending a finish_reason — a truncated
   * response. Used to be indistinguishable from a clean stop.
   */
  omitFinishReason?: boolean;
}

/**
 * Serve a scripted sequence of turns as SSE. Records each request body so tests
 * can assert on what the loop actually sent.
 */
function startMockServer(turns: ScriptedTurn[]): Promise<{
  server: Server;
  url: string;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  let turnIndex = 0;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      const turn = turns[Math.min(turnIndex++, turns.length - 1)] ?? {};

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });

      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      if (turn.text) {
        // Split text across chunks, as a real stream does.
        for (const piece of turn.text.match(/.{1,7}/gs) ?? []) {
          send({ choices: [{ delta: { content: piece }, finish_reason: null }] });
        }
      }

      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: '' } }],
              },
              finish_reason: null,
            },
          ],
        });
        // Arguments split mid-token — the case naive accumulation breaks on.
        for (const piece of call.args.match(/.{1,5}/gs) ?? []) {
          send({
            choices: [
              { delta: { tool_calls: [{ index, function: { arguments: piece } }] }, finish_reason: null },
            ],
          });
        }
      }

      if (!turn.omitFinishReason) {
        send({
          choices: [
            {
              delta: {},
              finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop'),
            },
          ],
        });
      }
      send({ choices: [], usage: turn.usage ?? { prompt_tokens: 100, completion_tokens: 20 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeModel(baseURL: string): ResolvedModel {
  const entry: ModelEntry = {
    provider: 'mock',
    model: 'mock-model',
    contextWindow: 200_000,
    maxOutput: 4096,
    pricing: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
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

interface Harness {
  cwd: string;
  conversation: Conversation;
  toolContext: ToolContext;
  tools: ReturnType<typeof buildTools>;
  config: ReturnType<typeof ConfigSchema.parse>;
}

function makeHarness(
  mode: 'safe' | 'auto-edit' | 'yolo' = 'yolo',
  limits: Record<string, number> = {},
): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-loop-'));
  writeFileSync(join(cwd, 'hello.txt'), 'line one\nline two\nline three\n');

  const config = ConfigSchema.parse({ permissions: { mode }, limits });
  const tools = buildTools({ todoStore: new TodoStore() });
  const conversation = new Conversation({ system: 'You are forge.', tools: toolSchemas(tools) });

  const toolContext: ToolContext = {
    cwd,
    config,
    signal: new AbortController().signal,
    permissions: new PermissionManager(mode, cwd),
    files: new FileTracker(),
  };

  return { cwd, conversation, toolContext, tools, config };
}

async function collect(
  harness: Harness,
  model: ResolvedModel,
  signal: AbortSignal,
  confirm: (r: PermissionRequest) => Promise<PermissionDecision> = async () => ({ type: 'allow' }),
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of runTurn({
    conversation: harness.conversation,
    model,
    tools: harness.tools,
    toolContext: { ...harness.toolContext, signal },
    config: harness.config,
    signal,
    confirm,
  })) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runs a full tool round-trip and terminates', async (t) => {
  const { server, url, requests } = await startMockServer([
    {
      text: 'Let me look.',
      toolCalls: [{ id: 'call_1', name: 'read_file', args: '{"path":"hello.txt"}' }],
    },
    { text: 'The file has three lines.' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('what is in hello.txt?');

  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.ok(toolEnd, 'the tool must actually execute');
  assert.equal(toolEnd.type === 'tool_end' && toolEnd.result.isError, undefined);
  assert.ok(
    toolEnd.type === 'tool_end' && toolEnd.result.content.includes('line two'),
    'the real file contents should come back',
  );

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'the loop must terminate when the model stops calling tools');

  // Two API calls: the tool-calling turn, then the answer.
  assert.equal(requests.length, 2);

  // The tool result must be its own user message following the assistant turn.
  const messages = harness.conversation.messages;
  const assistantWithTool = messages.find(
    (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
  );
  assert.ok(assistantWithTool);
  const resultTurn = messages.find((m) => m.content.some((b) => b.type === 'tool_result'));
  assert.ok(resultTurn, 'every tool_use needs a matching tool_result');
});

test('the second request resends the first as an unchanged prefix', async (t) => {
  const { server, url, requests } = await startMockServer([
    {
      toolCalls: [{ id: 'call_1', name: 'read_file', args: '{"path":"hello.txt"}' }],
    },
    { text: 'done' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('read it');
  await collect(harness, makeModel(url), new AbortController().signal);

  assert.equal(requests.length, 2);
  const first = requests[0] as { messages: unknown[]; tools: unknown[]; model: string };
  const second = requests[1] as { messages: unknown[]; tools: unknown[]; model: string };

  // This is the property the whole cost model depends on, asserted against the
  // actual bytes that went over the wire.
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools), 'tools must be frozen');
  assert.equal(
    JSON.stringify(second.messages.slice(0, first.messages.length)),
    JSON.stringify(first.messages),
    'request 2 must begin with request 1 verbatim, or the prompt cache misses',
  );
});

test('repairs malformed tool arguments instead of failing the turn', async (t) => {
  const { server, url } = await startMockServer([
    {
      // Trailing comma + Python literal: a very typical cheap-model emission.
      toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"hello.txt", "limit": 2,}' }],
    },
    { text: 'ok' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('read it');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.ok(toolEnd && toolEnd.type === 'tool_end');
  assert.notEqual(toolEnd.result.isError, true, 'repaired arguments should execute normally');
});

test('unparseable arguments become an error result, not a crash', async (t) => {
  const { server, url } = await startMockServer([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: 'I refuse to emit JSON' }] },
    { text: 'sorry' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('read it');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  // The session must survive so the model can correct itself next turn.
  assert.ok(events.find((e) => e.type === 'done'));
  const resultBlock = harness.conversation.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  assert.ok(resultBlock && resultBlock.type === 'tool_result' && resultBlock.is_error);
});

test('an unknown tool name is reported back to the model', async (t) => {
  const { server, url } = await startMockServer([
    { toolCalls: [{ id: 'c1', name: 'summon_daemon', args: '{}' }] },
    { text: 'my mistake' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  await collect(harness, makeModel(url), new AbortController().signal);

  const resultBlock = harness.conversation.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  assert.ok(resultBlock && resultBlock.type === 'tool_result');
  assert.match(resultBlock.content, /Unknown tool/);
  assert.match(resultBlock.content, /read_file/, 'should list what is available');
});

test('parallel tool calls run and return in a single message', async (t) => {
  const { server, url } = await startMockServer([
    {
      toolCalls: [
        { id: 'c1', name: 'read_file', args: '{"path":"hello.txt"}' },
        { id: 'c2', name: 'list_dir', args: '{"path":"."}' },
      ],
    },
    { text: 'both done' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('look around');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  assert.equal(events.filter((e) => e.type === 'tool_end').length, 2);

  const resultTurns = harness.conversation.messages.filter((m) =>
    m.content.some((b) => b.type === 'tool_result'),
  );
  assert.equal(resultTurns.length, 1, 'splitting results trains models out of parallel calls');
  assert.equal(resultTurns[0]?.content.length, 2);
});

test('a denied write is reported to the model and the file is untouched', async (t) => {
  const { server, url } = await startMockServer([
    {
      toolCalls: [
        { id: 'c1', name: 'write_file', args: '{"path":"hello.txt","content":"CLOBBERED"}' },
      ],
    },
    { text: 'understood' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness('safe');
  harness.conversation.addUserText('overwrite it');

  await collect(harness, makeModel(url), new AbortController().signal, async () => ({
    type: 'deny',
    reason: 'not this file',
  }));

  assert.equal(
    readFileSync(join(harness.cwd, 'hello.txt'), 'utf8'),
    'line one\nline two\nline three\n',
    'a denied write must not reach disk',
  );

  const resultBlock = harness.conversation.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  assert.ok(resultBlock && resultBlock.type === 'tool_result' && resultBlock.is_error);
  assert.match(resultBlock.content, /declined/i);
});

test('read-before-write blocks an unseen overwrite', async (t) => {
  const { server, url } = await startMockServer([
    {
      toolCalls: [
        { id: 'c1', name: 'write_file', args: '{"path":"hello.txt","content":"NEW"}' },
      ],
    },
    { text: 'ok' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness('yolo'); // even with no prompting, the invariant holds
  harness.conversation.addUserText('overwrite');
  await collect(harness, makeModel(url), new AbortController().signal);

  assert.equal(
    readFileSync(join(harness.cwd, 'hello.txt'), 'utf8'),
    'line one\nline two\nline three\n',
    'a file that was never read must not be overwritten',
  );

  const resultBlock = harness.conversation.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  assert.ok(resultBlock && resultBlock.type === 'tool_result');
  assert.match(resultBlock.content, /has not been read/i);
});

test('a path outside the project is rejected', async (t) => {
  const { server, url } = await startMockServer([
    { toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"../../../etc/passwd"}' }] },
    { text: 'ok' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('read it');
  await collect(harness, makeModel(url), new AbortController().signal);

  const resultBlock = harness.conversation.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  assert.ok(resultBlock && resultBlock.type === 'tool_result' && resultBlock.is_error);
  assert.match(resultBlock.content, /outside the project/i);
});

test('reports DeepSeek-style cache usage', async (t) => {
  const { server, url } = await startMockServer([
    {
      text: 'hi',
      usage: {
        prompt_tokens: 5000,
        prompt_cache_hit_tokens: 4800,
        prompt_cache_miss_tokens: 200,
        completion_tokens: 42,
      },
    },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('hello');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const usageEvent = events.find((e) => e.type === 'usage');
  assert.ok(usageEvent && usageEvent.type === 'usage');
  assert.equal(usageEvent.usage.cachedInputTokens, 4800);
  assert.equal(usageEvent.usage.inputTokens, 200);
  assert.equal(usageEvent.usage.outputTokens, 42);
});

test('an already-aborted signal stops before any request', async (t) => {
  const { server, url, requests } = await startMockServer([{ text: 'should not be reached' }]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');

  const controller = new AbortController();
  controller.abort();

  const events = await collect(harness, makeModel(url), controller.signal);
  assert.ok(events.find((e) => e.type === 'aborted'));
  assert.equal(requests.length, 0);
});

test('surfaces a provider error cleanly instead of throwing', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(
    harness,
    makeModel(`http://127.0.0.1:${port}`),
    new AbortController().signal,
  );

  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent && errorEvent.type === 'error');
  assert.match(errorEvent.message, /model not found/);
});

// ---------------------------------------------------------------------------
// Termination honesty (CRITICAL-2)
//
// `done` used to be emitted identically whether the model finished the task or
// gave up at the step cap, so headless returned exit 0 on a run that had
// achieved nothing. These pin the distinction.
// ---------------------------------------------------------------------------

test('a normal finish reports outcome "completed"', async (t) => {
  const { server, url } = await startMockServer([{ text: 'All done.' }]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'completed');
  assert.deepEqual(done.termination, { kind: 'completed' });
});

test('exhausting the step cap fails the run rather than reporting success', async (t) => {
  // A model that never stops asking for tools — the runaway case the cap exists
  // to stop. It must be reported as a failure, not a completion.
  const { server, url } = await startMockServer([
    {
      text: 'thinking...',
      toolCalls: [{ id: 'call_loop', name: 'read_file', args: '{"path":"hello.txt"}' }],
    },
  ]);
  t.after(() => server.close());

  const harness = makeHarness('yolo', { maxSteps: 3 });
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done', 'the loop must still emit a terminal event');
  assert.equal(done.outcome, 'failed', 'a step-cap stop is NOT a success');
  assert.deepEqual(done.termination, { kind: 'max_steps', steps: 3 });
  assert.equal(done.steps, 3);

  // The explanatory notice is still there — it is good guidance, it just has to
  // accompany a failure rather than a success.
  const notice = events.find((e) => e.type === 'notice' && /Stopped after 3 steps/.test(e.message));
  assert.ok(notice, 'the user still gets told why it stopped');
});

test('a truncated response is a failure, not a completion', async (t) => {
  const { server, url } = await startMockServer([
    { text: 'Here is the first half of the ans', finishReason: 'length' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.deepEqual(done.termination, { kind: 'output_truncated' });
});

test('a refusal is a failure', async (t) => {
  const { server, url } = await startMockServer([
    { text: 'I cannot help with that.', finishReason: 'content_filter' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.deepEqual(done.termination, { kind: 'refused' });
});

test('an unrecognized finish reason fails with unknown_stop and keeps the raw value', async (t) => {
  // Previously this was reported as `completed` on the theory that a strange
  // finish reason still meant a finished answer. It does not: we do not know
  // what the provider did, and claiming success is the same class of lie as
  // the max_steps case. The raw string is preserved so it can be diagnosed.
  const { server, url } = await startMockServer([
    { text: 'Partial answer.', finishReason: 'some_vendor_specific_reason' },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.deepEqual(done.termination, {
    kind: 'unknown_stop',
    raw: 'some_vendor_specific_reason',
  });
});

test('a stream that closes without any finish reason fails with incomplete_stream', async (t) => {
  // The false-success hole: the adapters used to seed stopReason with
  // 'end_turn', so a silently truncated response was reported as a clean
  // finish and headless exited 0 on a half-written answer.
  const { server, url } = await startMockServer([
    { text: 'Here is the first half of the ans', omitFinishReason: true },
  ]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.deepEqual(done.termination, { kind: 'incomplete_stream' });
});

test('an explicit clean stop is still reported as completed', async (t) => {
  // The allowlist must not be so strict that ordinary success now fails.
  const { server, url } = await startMockServer([{ text: 'All done.', finishReason: 'stop' }]);
  t.after(() => server.close());

  const harness = makeHarness();
  harness.conversation.addUserText('go');
  const events = await collect(harness, makeModel(url), new AbortController().signal);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.outcome, 'completed');
  assert.deepEqual(done.termination, { kind: 'completed' });
});
