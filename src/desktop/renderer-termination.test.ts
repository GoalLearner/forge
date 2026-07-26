/**
 * The renderer's termination copy must cover the same union as the TypeScript one.
 *
 * `renderer/app.js` is plain JS served under a strict CSP with no build step, so
 * it cannot import from the TypeScript sources and keeps a hand-written copy of
 * `describeTermination`. That is a drift hazard: add a reason in run.ts, forget
 * the renderer, and the desktop app silently falls back to a generic
 * "stopped before finishing" for a case that has specific, actionable text.
 *
 * This reads both files and asserts the renderer handles every kind the type
 * union declares. It is a source-level check rather than a DOM test on purpose
 * — it needs no browser and cannot be skipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeTermination, type AgentTerminationReason } from '../agent/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TS = readFileSync(join(HERE, '..', 'agent', 'run.ts'), 'utf8');
const APP_JS = readFileSync(join(HERE, 'renderer', 'app.js'), 'utf8');

/** Every `kind` declared on AgentTerminationReason. */
function declaredKinds(): string[] {
  const union = RUN_TS.slice(
    RUN_TS.indexOf('export type AgentTerminationReason'),
    RUN_TS.indexOf('/** Which terminal state a reason implies'),
  );
  return [...new Set([...union.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!))];
}

/** The cases the renderer's describeTermination actually handles. */
function rendererCases(): string[] {
  const start = APP_JS.indexOf('function describeTermination');
  const body = APP_JS.slice(start, APP_JS.indexOf('\n}', start));
  return [...new Set([...body.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]!))];
}

test('the renderer handles every declared termination kind', () => {
  const declared = declaredKinds();
  const handled = rendererCases();

  assert.ok(declared.length >= 12, `sanity: found ${declared.length} kinds`);

  // 'completed' is intentionally absent: the stopped card is only rendered for
  // non-completed outcomes, so a case for it would be dead code.
  const missing = declared.filter((k) => k !== 'completed' && !handled.includes(k));
  assert.deepEqual(missing, [], `renderer/app.js is missing: ${missing.join(', ')}`);
});

test('the renderer keeps a fallback for an unknown kind', () => {
  const start = APP_JS.indexOf('function describeTermination');
  const body = APP_JS.slice(start, APP_JS.indexOf('\n}', start));
  assert.match(body, /default:/, 'an unrecognised kind must degrade, not render undefined');
});

test('the Step 4A limits have specific text on both sides', () => {
  const handled = rendererCases();
  for (const kind of ['tool_timeout', 'max_runtime']) {
    assert.ok(handled.includes(kind), `renderer must explain ${kind}`);
  }

  const toolTimeout: AgentTerminationReason = {
    kind: 'tool_timeout',
    tool: 'run_shell',
    timeoutMs: 120_000,
  };
  const maxRuntime: AgentTerminationReason = { kind: 'max_runtime', elapsedMs: 900_000 };

  // Named limits read in human units, and name the tool that stalled.
  assert.match(describeTermination(toolTimeout), /run_shell/);
  assert.match(describeTermination(toolTimeout), /2 minutes/);
  assert.match(describeTermination(maxRuntime), /15 minutes/);
});

test('a limit is never described as a provider failure', () => {
  // The distinction matters: a provider failure invites a retry or a model
  // switch, a limit invites raising the limit or splitting the task.
  for (const reason of [
    { kind: 'tool_timeout', tool: 'run_shell', timeoutMs: 1000 },
    { kind: 'max_runtime', elapsedMs: 1000 },
  ] as AgentTerminationReason[]) {
    const text = describeTermination(reason).toLowerCase();
    assert.doesNotMatch(text, /provider|api|network|connection/);
  }
});

test('no termination text claims the task was completed', () => {
  const failures: AgentTerminationReason[] = [
    { kind: 'tool_timeout', tool: 'run_shell', timeoutMs: 1000 },
    { kind: 'max_runtime', elapsedMs: 1000 },
    { kind: 'max_steps', steps: 50 },
    { kind: 'incomplete_stream' },
  ];
  for (const reason of failures) {
    assert.doesNotMatch(describeTermination(reason).toLowerCase(), /\bcompleted\b|\bfinished the\b/);
  }
});
