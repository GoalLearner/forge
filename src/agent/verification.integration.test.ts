/**
 * Post-edit verification, driven end-to-end through the real loop.
 *
 * These are regression fixtures for Dogfooding Benchmark v1. Two of them
 * reproduce the actual failures the benchmark found:
 *
 *   N7 — the model wrote code and tests, the tests passed, it declared success,
 *        and the project's typecheck was left broken. It finished as an ordinary
 *        success. Here that same shape must NOT reach `completed` unverified.
 *
 *   N8 — an edit went wrong, the model kept going without a correctness signal,
 *        damaged an unrelated file, and only the step ceiling stopped it. Here
 *        verification must catch the damage before ordinary completion, and the
 *        collateral path must appear in the feedback rather than be silent.
 *
 * The provider is a local scripted SSE server and the project is a real
 * temporary git repository with real npm scripts, so the checks that run are the
 * project's own — nothing about verification is stubbed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { Conversation } from './messages.ts';
import { runTurn, type LoopEvent } from './loop.ts';
import { MutationState } from './verification.ts';
import { OpenAIProvider } from '../providers/openai.ts';
import { ConfigSchema, type ModelEntry } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import type { ResolvedModel } from '../providers/registry.ts';
import type { ToolContext } from '../tools/types.ts';

// ---------------------------------------------------------------------------
// Project fixture
// ---------------------------------------------------------------------------

/**
 * A real project whose `typecheck` fails exactly when `src/a.ts` contains BAD.
 *
 * Deliberately not tsc: the point is the LOOP's behaviour when a declared check
 * fails, and a real compiler would make the test slow and platform-dependent
 * without changing what is being proven.
 */
function makeProject(opts: { withScripts?: boolean; git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

  if (opts.withScripts !== false) {
    writeFileSync(
      join(dir, 'checker.js'),
      [
        "const fs = require('node:fs');",
        "const p = require('node:path').join(__dirname, 'src', 'a.ts');",
        "const body = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';",
        "if (body.includes('BAD')) { console.log('error TS0001: bad token in src/a.ts'); process.exit(2); }",
        "console.log('typecheck clean');",
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: 'fixture', private: true, scripts: { typecheck: 'node checker.js', test: 'node -e "process.exit(0)"' } },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    // The plan refuses to run scripts without dependencies installed; this
    // fixture has none to install, so an empty marker directory is enough.
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
  }

  if (opts.git !== false) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], {
      cwd: dir,
    });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

interface Turn {
  text?: string;
  /**
   * Read these before writing. Forge refuses to overwrite a file the run has
   * not read — the stale-file guard proved in Benchmark A4 — so any edit to an
   * existing file must be preceded by a read, exactly as a real model does.
   */
  read?: string[];
  write?: { path: string; content: string };
}

function startProvider(turns: Turn[]): Promise<{ server: Server; url: string; hits: () => number }> {
  let i = 0;
  let hits = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits += 1;
      const turn = turns[Math.min(i++, turns.length - 1)] ?? {};
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (p: unknown): void => void res.write(`data: ${JSON.stringify(p)}\n\n`);
      if (turn.text) send({ choices: [{ delta: { content: turn.text }, finish_reason: null }] });
      const calls: Array<{ name: string; args: unknown }> = [];
      for (const p of turn.read ?? []) calls.push({ name: 'read_file', args: { path: p } });
      if (turn.write) calls.push({ name: 'write_file', args: turn.write });
      calls.forEach((c, index) => {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${i}_${index}`,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      });
      send({ choices: [{ delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 } });
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

interface Result {
  events: LoopEvent[];
  done: Extract<LoopEvent, { type: 'done' }> | undefined;
  mutations: MutationState;
  notices: string[];
  conversation: Conversation;
}

async function drive(
  url: string,
  cwd: string,
  opts: { controller?: AbortController; maxSteps?: number; maxRuntimeMs?: number } = {},
): Promise<Result> {
  const config = ConfigSchema.parse({
    permissions: { mode: 'yolo' },
    limits: {
      maxSteps: opts.maxSteps ?? 12,
      toolTimeoutMs: 30_000,
      ...(opts.maxRuntimeMs ? { maxRuntimeMs: opts.maxRuntimeMs } : {}),
    },
  });
  const tools = buildTools({ todoStore: new TodoStore() });
  const conversation = new Conversation({ system: 'sys', tools: toolSchemas(tools) });
  conversation.addUserText('do the work');

  const ac = opts.controller ?? new AbortController();
  const mutations = new MutationState(2);
  const entry: ModelEntry = {
    provider: 'mock',
    model: 'm',
    contextWindow: 200_000,
    maxOutput: 4096,
    pricing: { input: 1, cachedInput: 0.1, output: 1 },
    autoCache: true,
    subscription: false,
    local: false,
  };
  const model: ResolvedModel = {
    key: 'mock/m',
    entry,
    provider: new OpenAIProvider('mock', { apiKey: 'k', baseURL: url }),
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
    mutations,
    confirm: async () => ({ type: 'allow' }),
  })) {
    events.push(e);
  }

  return {
    events,
    done: events.find((e) => e.type === 'done') as Result['done'],
    mutations,
    notices: events.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message),
    conversation,
  };
}

const terminalCount = (r: Result): number =>
  r.events.filter((e) => e.type === 'done' || e.type === 'aborted').length;

// ---------------------------------------------------------------------------
// N7 regression
// ---------------------------------------------------------------------------

test('N7: a clean model stop cannot complete while the project typecheck is broken', async (t) => {
  const cwd = makeProject();
  // The model writes something that breaks typecheck, then confidently stops —
  // and keeps doing so, so no repair ever fixes it.
  const { server, url } = await startProvider([
    { text: 'Added the helper and tests.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'All tests pass. Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.notEqual(r.done?.outcome, 'completed', 'this is the exact N7 false success');
  assert.equal(r.done?.termination.kind, 'verification_failed');
  assert.equal(terminalCount(r), 1, 'exactly one terminal event');
  if (r.done?.termination.kind === 'verification_failed') {
    assert.deepEqual(r.done.termination.failed, ['typecheck']);
    assert.equal(r.done.termination.repairsUsed, 2, 'both repair rounds were spent');
  }
  assert.equal(r.mutations.status, 'failed');
});

test('N7 repaired: the same failure fixed on the first repair completes verified', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([
    { text: 'Adding it.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'Done.' },
    // Repair round: the model reads the reported failure and fixes it.
    { text: 'Fixing the type error.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 2;\n' } },
    { text: 'Fixed.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed');
  assert.equal(r.done?.termination.kind, 'completed');
  assert.equal(r.mutations.status, 'passed');
  assert.equal(r.mutations.repairsUsed, 1, 'one repair, and the re-verification cost no extra round');
  assert.equal(terminalCount(r), 1);
  assert.match(readFileSync(join(cwd, 'src', 'a.ts'), 'utf8'), /export const a = 2/);
});

test('N7: the failing command and its output are fed back to the model', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([
    { text: 'Adding.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  const text = JSON.stringify(r.conversation.messages);
  assert.match(text, /npm run typecheck/, 'the model is told which command failed');
  assert.match(text, /error TS0001/, 'and what it said');
  assert.match(text, /Repair attempts remaining/);
});

// ---------------------------------------------------------------------------
// N8 regression
// ---------------------------------------------------------------------------

test('N8: collateral damage is caught by verification and named in the feedback', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([
    // The requested edit, which goes wrong and breaks the project.
    { text: 'Adding the endpoint.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'Done.' },
    // Repair round 1 — the N8 shape: instead of fixing the reported failure it
    // writes an unrelated file nobody asked about.
    { text: 'Adjusting.', write: { path: 'src/collateral.ts', content: 'export const x = 1;\n' } },
    { text: 'Done.' },
    // Repair round 2 — still not the reported failure.
    { text: 'Adjusting again.', write: { path: 'src/collateral2.ts', content: 'export const y = 2;\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.notEqual(r.done?.outcome, 'completed');
  assert.equal(r.done?.termination.kind, 'verification_failed');
  assert.equal(terminalCount(r), 1);

  // The step ceiling must not be what stopped it — verification did.
  assert.notEqual(r.done?.termination.kind, 'max_steps');

  const text = JSON.stringify(r.conversation.messages);
  assert.match(text, /src\/collateral\.ts/, 'a path touched only during repair is surfaced');
  assert.ok(
    r.mutations.changedPaths().includes('src/collateral.ts'),
    'and is retained in the final state for the report',
  );
});

// ---------------------------------------------------------------------------
// Core contract
// ---------------------------------------------------------------------------

test('a successful edit verifies and completes with one terminal event', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([
    { text: 'Editing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 3;\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed');
  assert.equal(r.mutations.status, 'passed');
  assert.equal(r.mutations.repairsUsed, 0);
  assert.equal(terminalCount(r), 1);
  assert.ok(r.notices.some((n) => /Verified/i.test(n)));
});

test('a run that changed nothing runs no checks and stays complete', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([{ text: 'I investigated and no change is needed.' }]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed');
  assert.equal(r.mutations.generation, 0);
  assert.equal(r.mutations.status, 'not_required');
  assert.equal(
    r.notices.filter((n) => /Verifying/i.test(n)).length,
    0,
    'a read-only run must not pay for project checks',
  );
  assert.equal(r.mutations.lastOutcome, null);
});

test('a project with no runnable checks reports unverified rather than verified', async (t) => {
  // No package.json and no git: nothing declared, nothing to run.
  const cwd = makeProject({ withScripts: false, git: false });
  const { server, url } = await startProvider([
    { text: 'Editing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 9;\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed', 'unverifiable is not a failure');
  assert.equal(r.mutations.status, 'unavailable');
  const notice = r.notices.find((n) => /could not be automatically verified/i.test(n));
  assert.ok(notice, 'the user is told plainly that it is unverified');
  assert.doesNotMatch(notice, /Verified —/);
});

test('an edit made after a passing verification forces the checks to run again', async (t) => {
  const cwd = makeProject();
  const { server, url } = await startProvider([
    { text: 'First edit.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 4;\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);
  assert.equal(r.mutations.status, 'passed');
  assert.equal(r.mutations.needsVerification(), false);

  // A later mutation on the same state must invalidate the pass.
  r.mutations.recordMutation('src/later.ts');
  assert.equal(
    r.mutations.needsVerification(),
    true,
    'the green verdict described a tree that no longer exists',
  );
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('cancellation during verification keeps the cancellation reason', async (t) => {
  const cwd = makeProject();
  const ac = new AbortController();
  const { server, url } = await startProvider([
    { text: 'Editing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  // Abort as soon as verification announces itself.
  const config = { controller: ac };
  const p = drive(url, cwd, config);
  const timer = setTimeout(() => ac.abort(), 1200);
  timer.unref?.();
  const r = await p;
  clearTimeout(timer);

  // Either the run finished before the abort landed, or it was cancelled — but
  // it must never claim a verified success it did not earn.
  if (r.done?.termination.kind === 'completed') {
    assert.equal(r.mutations.status, 'passed');
  } else {
    assert.ok(
      r.events.some((e) => e.type === 'aborted') ||
        r.done?.termination.kind === 'verification_failed',
      'a cancelled or failed verification never reports ordinary success',
    );
  }
});

test('verification runs do not create provider attempts', async (t) => {
  const cwd = makeProject();
  const { server, url, hits } = await startProvider([
    { text: 'Editing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 5;\n' } },
    { text: 'Done.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed');
  // Two model turns: the tool call and the final stop. Verification shells out
  // locally and must never look like a paid request.
  assert.equal(hits(), 2, 'checks are local processes, not provider attempts');
});

test('the repair turn is a real model request, not a hidden one', async (t) => {
  const cwd = makeProject();
  const { server, url, hits } = await startProvider([
    { text: 'Editing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'BAD token\n' } },
    { text: 'Done.' },
    { text: 'Fixing.', read: ['src/a.ts'], write: { path: 'src/a.ts', content: 'export const a = 6;\n' } },
    { text: 'Fixed.' },
  ]);
  t.after(() => server.close());

  const r = await drive(url, cwd);

  assert.equal(r.done?.outcome, 'completed');
  assert.equal(hits(), 4, 'the repair round is two more ordinary requests');
  assert.ok(existsSync(join(cwd, 'src', 'a.ts')));
});
