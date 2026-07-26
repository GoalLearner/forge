/**
 * The taskkill decision contract — Stage 0's central invariant.
 *
 * Stage 0 says: when Forge reports that a run stopped, it must not falsely
 * claim the underlying work was terminated. The defect these tests exist to
 * prevent was a single expression:
 *
 *     killer.on('exit', (code) => done(code === 0 || code === 128));
 *
 * On Windows, 128 does NOT mean "already gone". `taskkill /PID 4 /T /F` exits
 * 128 with "could not be terminated. Reason: Access is denied" while the
 * process keeps running. Folding that into success meant Forge claimed a clean
 * tree kill, skipped the fallback, suppressed the warning, and could reopen the
 * non-settling shell path.
 *
 * These drive the REAL `decideTreeKill` and the REAL `killTree` — production
 * imports the same functions. Only the process-level effects (spawning
 * taskkill, checking liveness, killing the wrapper) are injected, because
 * access-denied and helper-timeout cannot be produced on demand otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';

import {
  decideTreeKill,
  isProcessAlive,
  killTree,
  runCommand,
  resolveShell,
  type KillDeps,
  type TaskkillResult,
} from './shell.ts';

const ACCESS_DENIED =
  'ERROR: The process with PID 4321 (child process of PID 1234) could not be terminated.\r\nReason: Access is denied.';
const NOT_FOUND = 'ERROR: The process "1234" not found.';

const evidence = (over: Partial<TaskkillResult> = {}): TaskkillResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  ...over,
});

/**
 * A stand-in for the spawned wrapper; only `pid` and `kill` are consulted.
 * No default parameter — `= 1234` would swallow an explicitly-passed
 * `undefined`, which is exactly the missing-pid case under test.
 */
function fakeChild(pid: number | undefined): ChildProcess & { killed: boolean } {
  const child = { pid, killed: false, kill: () => (child.killed = true) };
  return child as unknown as ChildProcess & { killed: boolean };
}

function deps(over: Partial<KillDeps> = {}): KillDeps {
  return {
    runTaskkill: async () => evidence(),
    isAlive: () => false,
    killWrapper: (child) => {
      (child as unknown as { killed: boolean }).killed = true;
    },
    taskkillTimeoutMs: 50,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The policy, in isolation
// ---------------------------------------------------------------------------

test('exit 0 with the wrapper gone is the ONLY confirmed tree kill', () => {
  const v = decideTreeKill(evidence({ exitCode: 0 }), false);
  assert.equal(v.outcome, 'tree');
  assert.equal(v.needsFallback, false);
  assert.equal(v.detail, undefined, 'a confirmed kill carries no warning text');
});

test('exit 0 while the wrapper is still alive is NOT confirmed', () => {
  const v = decideTreeKill(evidence({ exitCode: 0 }), true);
  assert.equal(v.outcome, 'unconfirmed');
  assert.equal(v.needsFallback, true);
  assert.match(v.detail ?? '', /still running/);
});

test('exit 128 with access denied is never a clean tree kill', () => {
  const v = decideTreeKill(evidence({ exitCode: 128, stderr: ACCESS_DENIED }), true);
  assert.equal(v.outcome, 'unconfirmed');
  assert.equal(v.needsFallback, true);
  assert.match(v.detail ?? '', /access denied/i);
});

test('exit 128 with the wrapper already gone is STILL unconfirmed', () => {
  // The asymmetry that matters: taskkill walks the tree top-down, so it can
  // fail on a protected descendant after the wrapper itself has exited. A
  // missing wrapper says nothing about its children.
  const v = decideTreeKill(evidence({ exitCode: 128, stderr: ACCESS_DENIED }), false);
  assert.equal(v.outcome, 'unconfirmed', 'wrapper absence must not upgrade 128 to success');
  assert.equal(v.needsFallback, false, 'nothing left to fall back onto');
  assert.match(v.detail ?? '', /access denied/i);
});

test('exit 128 for a genuinely missing process is diagnosed as such', () => {
  const v = decideTreeKill(evidence({ exitCode: 128, stderr: NOT_FOUND }), false);
  assert.equal(v.outcome, 'unconfirmed', 'still not a confirmed tree kill');
  assert.match(v.detail ?? '', /not found/i);
});

test('any other nonzero exit is unconfirmed and names the code', () => {
  const v = decideTreeKill(evidence({ exitCode: 1 }), true);
  assert.equal(v.outcome, 'unconfirmed');
  assert.equal(v.needsFallback, true);
  assert.match(v.detail ?? '', /code 1/);
});

test('a helper timeout is unconfirmed', () => {
  const v = decideTreeKill(evidence({ exitCode: null, timedOut: true }), true);
  assert.equal(v.outcome, 'unconfirmed');
  assert.match(v.detail ?? '', /timed out/i);
});

test('a launch failure is unconfirmed', () => {
  const v = decideTreeKill(evidence({ exitCode: null, launchError: 'ENOENT' }), true);
  assert.equal(v.outcome, 'unconfirmed');
  assert.equal(v.needsFallback, true);
  assert.match(v.detail ?? '', /could not be launched/i);
});

test('no branch of the policy can return a bare "tree" without exit 0', () => {
  const hostile: TaskkillResult[] = [
    evidence({ exitCode: 128 }),
    evidence({ exitCode: 1 }),
    evidence({ exitCode: -1 }),
    evidence({ exitCode: null }),
    evidence({ exitCode: null, timedOut: true }),
    evidence({ exitCode: null, launchError: 'boom' }),
  ];
  for (const e of hostile) {
    for (const alive of [true, false]) {
      assert.equal(decideTreeKill(e, alive).outcome, 'unconfirmed', JSON.stringify(e));
    }
  }
});

// ---------------------------------------------------------------------------
// Liveness helper
// ---------------------------------------------------------------------------

test('isProcessAlive reports the current process as alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive reports an impossible pid as gone', () => {
  assert.equal(isProcessAlive(0x7ffffff0), false);
});

test('isProcessAlive does not treat an unknown error as "gone"', () => {
  // Conservative by construction: only ESRCH proves absence. PID 4 on Windows
  // exists but cannot be signalled — that must read as alive, not as gone.
  if (process.platform === 'win32') {
    assert.equal(isProcessAlive(4), true, 'a protected but existing process is alive');
  }
});

// ---------------------------------------------------------------------------
// killTree wiring (production function, injected effects)
// ---------------------------------------------------------------------------

test('killTree does not run the fallback on a confirmed kill', async (t) => {
  if (process.platform !== 'win32') return t.skip('windows-only path');
  const child = fakeChild(1234);
  const result = await killTree(child, deps({ runTaskkill: async () => evidence({ exitCode: 0 }) }));

  assert.equal(result.outcome, 'tree');
  assert.equal(result.fallbackUsed, false);
  assert.equal(child.killed, false, 'the wrapper must not be killed when taskkill succeeded');
});

test('killTree falls back only after taskkill has finished, and reports degraded', async (t) => {
  if (process.platform !== 'win32') return t.skip('windows-only path');
  const order: string[] = [];
  const child = fakeChild(1234);

  const result = await killTree(
    child,
    deps({
      runTaskkill: async () => {
        order.push('taskkill');
        return evidence({ exitCode: 128, stderr: ACCESS_DENIED });
      },
      isAlive: () => true,
      killWrapper: (c) => {
        order.push('fallback');
        (c as unknown as { killed: boolean }).killed = true;
      },
    }),
  );

  assert.deepEqual(order, ['taskkill', 'fallback'], 'the tree is never destroyed first');
  assert.equal(result.outcome, 'unconfirmed');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.detail ?? '', /access denied/i);
  assert.equal(child.killed, true);
});

test('killTree handles a missing pid without claiming success', async () => {
  const result = await killTree(fakeChild(undefined), deps());
  assert.equal(result.outcome, 'unconfirmed');
});

// ---------------------------------------------------------------------------
// End-to-end through runCommand: the warning must survive to the result
// ---------------------------------------------------------------------------

const shell = resolveShell({ kind: 'auto' });
const LONG = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';

async function runWithDeps(over: Partial<KillDeps>): Promise<{
  tree: { outcome: string; detail?: string } | null;
}> {
  const controller = new AbortController();
  const pending = runCommand(shell, LONG, {
    cwd: process.cwd(),
    timeoutMs: 60_000,
    signal: controller.signal,
    maxBytes: 10_000,
    // Real taskkill is replaced, but the wrapper still has to be stopped or the
    // command would run for 30s — so the injected fallback does a real kill.
    killDeps: {
      runTaskkill: async () => evidence({ exitCode: 128, stderr: ACCESS_DENIED }),
      isAlive: () => true,
      killWrapper: (c) => c.kill(),
      taskkillTimeoutMs: 100,
      ...over,
    },
  });
  setTimeout(() => controller.abort(), 150);
  return (await pending) as unknown as { tree: { outcome: string; detail?: string } | null };
}

test('an unconfirmed kill reaches the tool result as a visible warning', async () => {
  const result = await runWithDeps({});
  assert.equal(result.tree?.outcome, 'unconfirmed');
  assert.match(result.tree?.detail ?? '', /access denied/i);
});

test('the outcome is resolved before settlement, repeatedly (race regression)', async () => {
  // The old code assigned treeOutcome inside a floating `.then`, so a wrapper
  // closing promptly after the fallback could settle the tool first and lose
  // the warning entirely. Repeated to catch a scheduling-dependent flake.
  for (let i = 0; i < 8; i++) {
    const result = await runWithDeps({});
    assert.equal(result.tree?.outcome, 'unconfirmed', `iteration ${i}: outcome lost`);
    assert.ok(result.tree?.detail, `iteration ${i}: detail lost`);
  }
});

test('a taskkill helper timeout still settles and degrades honestly', async () => {
  // Fake time in the sense that matters: the injected runner reports a timeout
  // immediately, so the real 5s helper bound is exercised as policy without
  // waiting 5s.
  const result = await runWithDeps({
    runTaskkill: async () => evidence({ exitCode: null, timedOut: true }),
  });
  assert.equal(result.tree?.outcome, 'unconfirmed');
  assert.match(result.tree?.detail ?? '', /timed out/i);
});

test('a taskkill launch failure still settles and degrades honestly', async () => {
  const result = await runWithDeps({
    runTaskkill: async () => evidence({ exitCode: null, launchError: 'ENOENT' }),
  });
  assert.equal(result.tree?.outcome, 'unconfirmed');
  assert.match(result.tree?.detail ?? '', /could not be launched/i);
});

test('a command that exits on its own carries no tree verdict at all', async () => {
  const result = (await runCommand(shell, 'echo done', {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    maxBytes: 10_000,
  })) as unknown as { tree: unknown };
  assert.equal(result.tree, null, 'nothing was terminated, so nothing is claimed');
});
