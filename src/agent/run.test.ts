/**
 * Run-envelope invariants.
 *
 * The whole point of the envelope is that a run can never end ambiguously: it
 * lands in exactly one terminal state, always carrying a reason. These tests
 * pin that down, plus the two subtleties that are easy to get wrong — the
 * transition table, and excluding human-blocked time from the active clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRun,
  InvalidTransitionError,
  describeTermination,
  isTerminal,
  newRunId,
  stateForReason,
  type AgentLimits,
  type AgentTerminationReason,
} from './run.ts';

const LIMITS: AgentLimits = {
  maxSteps: 50,
  maxRetriesPerCall: 4,
  maxRetriesPerRun: 4,
  toolTimeoutMs: 120_000,
  maxRuntimeMs: 900_000,
  maxExplicitShellTimeoutMs: 600_000,
};

/** A run with a controllable clock, so timing assertions are deterministic. */
function makeRun(opts: { sessionId?: string | null; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 1_000 };
  const run = new AgentRun({
    // `??` would swallow an explicitly-passed null, which is the case under test.
    sessionId: 'sessionId' in opts ? (opts.sessionId ?? null) : 'sess_1',
    limits: LIMITS,
    abort: new AbortController(),
    now: () => clock.t,
  });
  return { run, clock };
}

// --- identity --------------------------------------------------------------

test('every run gets a unique id', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
  assert.equal(ids.size, 200);
  assert.match(newRunId(), /^run_[a-z0-9]+_[0-9a-f]{8}$/);
});

test('sessionId may start null and be filled once the row exists', () => {
  const { run } = makeRun({ sessionId: null });
  assert.equal(run.sessionId, null);
  run.sessionId = 'sess_created_on_first_send';
  assert.equal(run.sessionId, 'sess_created_on_first_send');
});

// --- transitions -----------------------------------------------------------

test('a legal path through the machine succeeds', () => {
  const { run } = makeRun();
  assert.equal(run.state, 'idle');
  for (const to of ['thinking', 'running_tool', 'thinking', 'verifying', 'completed'] as const) {
    run.transition(to);
  }
  assert.equal(run.state, 'completed');
  assert.ok(run.finished);
});

test('a finished run cannot be resurrected', () => {
  const { run } = makeRun();
  run.transition('thinking');
  run.finish({ kind: 'completed' });

  assert.throws(() => run.transition('thinking'), InvalidTransitionError);
  assert.throws(() => run.transition('running_tool'), InvalidTransitionError);
});

test('illegal jumps are rejected', () => {
  const { run } = makeRun();
  // idle cannot go straight to running a tool — a model call comes first.
  assert.throws(() => run.transition('running_tool'), InvalidTransitionError);
  // verifying is a decision point; it cannot go back to work.
  run.transition('thinking');
  run.transition('verifying');
  assert.throws(() => run.transition('running_tool'), InvalidTransitionError);
});

test('any working state can be cancelled', () => {
  for (const from of ['idle', 'thinking', 'awaiting_approval', 'running_tool'] as const) {
    const { run } = makeRun();
    if (from !== 'idle') run.transition('thinking');
    if (from === 'awaiting_approval' || from === 'running_tool') run.transition(from);
    run.finish({ kind: 'cancelled', by: 'user' });
    assert.equal(run.state, 'cancelled', `from ${from}`);
  }
});

// --- termination -----------------------------------------------------------

test('exactly one terminal state, and termination is always set', () => {
  const reasons: AgentTerminationReason[] = [
    { kind: 'completed' },
    { kind: 'max_steps', steps: 50 },
    { kind: 'output_truncated' },
    { kind: 'refused' },
    { kind: 'provider_error', message: 'boom' },
    { kind: 'cancelled', by: 'superseded' },
    { kind: 'tool_timeout', tool: 'run_shell', timeoutMs: 1000 },
  ];

  for (const reason of reasons) {
    const { run } = makeRun();
    run.transition('thinking');
    const landed = run.finish(reason);

    assert.ok(isTerminal(run.state), `${reason.kind} should be terminal`);
    assert.equal(landed, run.state);
    assert.equal(landed, stateForReason(reason));
    assert.deepEqual(run.termination, reason);
    assert.ok(describeTermination(reason).length > 0);
  }
});

test('only "completed" counts as success — a limit is a failure', () => {
  assert.equal(stateForReason({ kind: 'completed' }), 'completed');
  assert.equal(stateForReason({ kind: 'max_steps', steps: 50 }), 'failed');
  assert.equal(stateForReason({ kind: 'output_truncated' }), 'failed');
  assert.equal(stateForReason({ kind: 'refused' }), 'failed');
  assert.equal(stateForReason({ kind: 'cancelled', by: 'user' }), 'cancelled');
});

test('finish is idempotent — the first reason wins', () => {
  const { run } = makeRun();
  run.transition('thinking');

  run.finish({ kind: 'cancelled', by: 'user' });
  run.finish({ kind: 'provider_error', message: 'late failure' });

  assert.equal(run.state, 'cancelled');
  assert.deepEqual(run.termination, { kind: 'cancelled', by: 'user' });
  assert.equal(run.endedAt !== null, true);
});

// --- clocks ----------------------------------------------------------------

test('activeMs excludes time parked awaiting approval', () => {
  const clock = { t: 0 };
  const { run } = makeRun({ clock });

  clock.t = 1_000;
  run.transition('thinking'); // 1s of real work

  run.transition('awaiting_approval');
  clock.t = 61_000; // the user went to lunch: 60s blocked on a human

  run.transition('running_tool');
  clock.t = 63_000; // 2s of real work

  run.finish({ kind: 'completed' });

  assert.equal(run.elapsedMs(), 63_000);
  assert.equal(run.activeMs(), 3_000, 'approval time must not count as active');
});

test('activeMs is correct while still parked', () => {
  const clock = { t: 0 };
  const { run } = makeRun({ clock });
  run.transition('thinking');
  clock.t = 500;
  run.transition('awaiting_approval');
  clock.t = 30_500;

  assert.equal(run.elapsedMs(), 30_500);
  assert.equal(run.activeMs(), 500, 'in-flight parking counts too');
});

test('elapsed stops advancing once the run is terminal', () => {
  const clock = { t: 0 };
  const { run } = makeRun({ clock });
  run.transition('thinking');
  clock.t = 2_000;
  run.finish({ kind: 'completed' });

  clock.t = 999_000;
  assert.equal(run.elapsedMs(), 2_000);
});

// --- budgets ---------------------------------------------------------------

test('outOfSteps reflects the step budget', () => {
  const { run } = makeRun();
  assert.equal(run.outOfSteps(), false);
  run.step = LIMITS.maxSteps - 1;
  assert.equal(run.outOfSteps(), false);
  run.step = LIMITS.maxSteps;
  assert.equal(run.outOfSteps(), true);
});

test('snapshot carries the fields the UI needs', () => {
  const { run } = makeRun();
  run.transition('thinking');
  run.step = 3;
  run.finish({ kind: 'max_steps', steps: 50 });

  const snap = run.snapshot();
  assert.equal(snap.id, run.id);
  assert.equal(snap.state, 'failed');
  assert.equal(snap.step, 3);
  assert.deepEqual(snap.termination, { kind: 'max_steps', steps: 50 });
});
