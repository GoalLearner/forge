/**
 * run_shell must kill the whole process TREE, and must not settle until it has.
 *
 * The bug this replaces: `killTree` spawned `taskkill /T /F` and then
 * immediately called `child.kill()` on the wrapper. That destroyed the
 * parent→child tree before taskkill could walk it, so descendants were
 * orphaned — and an orphan holding the inherited stdout/stderr handles keeps
 * the wrapper's 'close' event from ever firing. Since the agent loop *awaits*
 * tool settlement, the tool promise (and the whole AgentRun) hung forever.
 *
 * The old test was nondeterministic — repeated runs gave pass, fail and hang —
 * because it inferred "descendant died" from a `wmic` command-line match that
 * frequently never appeared in the first place, so it could pass without ever
 * having created the thing it claimed to kill.
 *
 * This version is deterministic:
 *   - the descendant writes its PID and a heartbeat to disk
 *   - the test FAILS if that descendant is never observed alive
 *   - cancellation is only triggered once it IS alive
 *   - survival is checked by PID existence, not by string matching
 *   - every case has its own watchdog, so a regression fails instead of hanging
 *   - cleanup runs even when an assertion throws
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shellTool } from './shell.ts';
import { ConfigSchema } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import type { ToolContext } from './types.ts';

const IS_WINDOWS = process.platform === 'win32';

interface Fixture {
  cwd: string;
  ctx: ToolContext;
  pidFile: string;
  beatFile: string;
  controller: AbortController;
}

/**
 * A project whose shell command launches a *separate* background process — the
 * grandchild that inherits the pipes and used to wedge everything.
 */
function makeFixture(toolTimeoutMs?: number): Fixture {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'forge-tree-')));
  const pidFile = join(cwd, 'pid.txt');
  const beatFile = join(cwd, 'beat.txt');

  writeFileSync(
    join(cwd, 'gc.js'),
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `setInterval(() => require('fs').writeFileSync(${JSON.stringify(beatFile)}, String(Date.now())), 100);\n`,
  );

  const controller = new AbortController();
  return {
    cwd,
    pidFile,
    beatFile,
    controller,
    ctx: {
      cwd,
      config: ConfigSchema.parse({ permissions: { mode: 'yolo' } }),
      signal: controller.signal,
      permissions: new PermissionManager('yolo', cwd),
      files: new FileTracker(),
      ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    },
  };
}

/** Launch the grandchild, then hold the wrapper open for a long time. */
const COMMAND = IS_WINDOWS
  ? 'Start-Process -NoNewWindow node -ArgumentList "gc.js"; Start-Sleep -Seconds 45'
  : 'node gc.js & sleep 45';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the descendant proves it is running, or fail the test. */
async function waitForDescendant(fx: Fixture, budgetMs = 15_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(fx.pidFile) && existsSync(fx.beatFile)) {
      const pid = Number(readFileSync(fx.pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid;
    }
    await sleep(100);
  }
  assert.fail('descendant never started — this test proves nothing unless it does');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, kills nothing
    return true;
  } catch {
    return false;
  }
}

function reap(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Fail loudly rather than hanging the whole test process. */
function watchdog<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`WATCHDOG: ${label} did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------

test('a timed-out shell command terminates its whole process tree and settles', async () => {
  const fx = makeFixture(60_000); // long tool budget; we cancel manually instead
  let pid: number | null = null;

  try {
    const pending = shellTool.execute({ command: COMMAND }, fx.ctx);
    // Never let an unhandled rejection escape if the assertions below throw.
    pending.catch(() => {});

    // 1-3: wrapper started, descendant started, descendant OBSERVED alive.
    pid = await waitForDescendant(fx);
    assert.ok(alive(pid), 'descendant must be alive before we cancel');

    // 6: cancellation only after the descendant is confirmed alive.
    fx.controller.abort();

    // 8-9: the promise stays pending until the wrapper's close event fires,
    // which can only happen once the descendant releases the inherited pipes.
    const result = await watchdog(pending, 30_000, 'shellTool.execute');
    assert.equal(result.isError, true, 'a killed command is not a success');

    // 11: the descendant is gone by PID, not by string matching.
    assert.equal(alive(pid), false, 'descendant survived the tree kill');

    // 10/12: the heartbeat must be frozen — nothing may still be writing after
    // the tool settled. Sampled twice across a gap wider than its 100ms period.
    const beatAtSettle = readFileSync(fx.beatFile, 'utf8');
    await sleep(500);
    const beatLater = readFileSync(fx.beatFile, 'utf8');
    assert.equal(beatLater, beatAtSettle, 'heartbeat kept advancing after the run settled');
    assert.equal(alive(pid), false, 'still gone after settling');
  } finally {
    reap(pid);
  }
});

test('a tool-timeout (not just an abort) also kills the tree and settles', async () => {
  // Same guarantee, driven by the loop-resolved deadline rather than a signal.
  const fx = makeFixture(1_500);
  let pid: number | null = null;

  try {
    const pending = shellTool.execute({ command: COMMAND }, fx.ctx);
    pending.catch(() => {});

    pid = await waitForDescendant(fx);
    assert.ok(alive(pid));

    const result = await watchdog(pending, 30_000, 'shellTool.execute (timeout path)');
    assert.equal(result.isError, true);
    assert.match(result.content, /timed out/i);
    assert.equal(alive(pid), false, 'descendant survived the timeout kill');
  } finally {
    reap(pid);
  }
});

test('a command that exits on its own is unaffected', async () => {
  const fx = makeFixture(20_000);
  const result = await watchdog(
    shellTool.execute({ command: 'echo forge-ok' }, fx.ctx),
    20_000,
    'echo',
  );
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /forge-ok/);
  // A clean exit must NOT carry the "could not confirm children" warning.
  assert.doesNotMatch(result.content, /could not confirm/);
});
