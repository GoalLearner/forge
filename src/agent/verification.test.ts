/**
 * Post-edit verification: mutation tracking, plan discovery, execution.
 *
 * The property every test here defends is the one Benchmark v1 found missing:
 * **Forge must not call a changed tree correct until the project's own checks
 * say so.** The subtle half is staleness — a pass describes one exact tree, and
 * an edit made after it must invalidate it rather than ride on it.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MutationState,
  buildVerificationPlan,
  executeVerification,
  scriptCommand,
  describeVerification,
  buildRepairMessage,
  advisoryWarnings,
  type VerificationPlan,
} from './verification.ts';

// ---------------------------------------------------------------------------
// Fake filesystem for plan discovery
// ---------------------------------------------------------------------------

function fs(files: Record<string, string>) {
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    exists: (p: string) => Object.keys(files).some((f) => norm(p).endsWith(f)),
    readFile: (p: string) => {
      const key = Object.keys(files).find((f) => norm(p).endsWith(f));
      if (!key) throw new Error(`not found: ${p}`);
      return files[key]!;
    },
  };
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

function plan(files: Record<string, string>): VerificationPlan {
  return buildVerificationPlan('/proj', { timeoutMs: 1000, isGitRepo: false, deps: fs(files) });
}

const names = (p: VerificationPlan): string[] => p.checks.map((c) => c.name);

// ---------------------------------------------------------------------------
// Mutation generation
// ---------------------------------------------------------------------------

describe('mutation state', () => {
  test('a run that changed nothing needs no verification', () => {
    const m = new MutationState(2);
    assert.equal(m.generation, 0);
    assert.equal(m.status, 'not_required');
    assert.equal(m.needsVerification(), false);
  });

  test('a successful write moves to generation 1 and pends verification', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');
    assert.equal(m.generation, 1);
    assert.equal(m.status, 'pending');
    assert.equal(m.needsVerification(), true);
    assert.deepEqual(m.changedPaths(), ['src/a.ts']);
  });

  test('a second write moves to generation 2', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');
    m.recordMutation('src/b.ts');
    assert.equal(m.generation, 2);
    assert.deepEqual(m.changedPaths(), ['src/a.ts', 'src/b.ts']);
  });

  test('a pass authorizes only the generation it observed', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');
    m.recordVerification({ status: 'passed', checks: [], generation: 1 });
    assert.equal(m.needsVerification(), false, 'generation 1 is verified');

    // The model edits again after the checks were green.
    m.recordMutation('src/b.ts');
    assert.equal(
      m.needsVerification(),
      true,
      'the earlier pass described a tree that no longer exists',
    );
  });

  test('a verdict for a stale generation cannot authorize the current one', () => {
    const m = new MutationState(2);
    m.recordMutation('a');
    m.recordMutation('b'); // generation 2
    // A verdict arrives describing generation 1 — e.g. the tree moved mid-check.
    m.recordVerification({ status: 'passed', checks: [], generation: 1 });
    assert.equal(m.needsVerification(), true);
  });

  test('a mutation with no reportable path still counts', () => {
    const m = new MutationState(2);
    m.recordMutation();
    assert.equal(m.generation, 1);
    assert.deepEqual(m.changedPaths(), [], 'unknown paths are not invented');
    assert.equal(m.needsVerification(), true);
  });

  test('a finalized state rejects late events', () => {
    const m = new MutationState(2);
    m.recordMutation('a');
    m.finalize();
    m.recordMutation('b');
    m.recordVerification({ status: 'passed', checks: [], generation: 99 });
    assert.equal(m.generation, 1, 'a superseded run cannot rewrite a reported verdict');
    assert.equal(m.consumeRepair(), false);
  });

  test('each run gets its own allowance', () => {
    const first = new MutationState(2);
    first.consumeRepair();
    first.consumeRepair();
    assert.equal(first.canRepair(), false);

    const second = new MutationState(2);
    assert.equal(second.repairsUsed, 0);
    assert.equal(second.canRepair(), true);
  });

  test('paths added during a repair are identifiable', () => {
    const m = new MutationState(2);
    m.recordMutation('src/wanted.ts');
    m.consumeRepair();
    m.recordMutation('src/collateral.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), ['src/collateral.ts']);
  });
});

// ---------------------------------------------------------------------------
// Plan discovery
// ---------------------------------------------------------------------------

describe('plan discovery', () => {
  test('npm project selects typecheck, test and build in that order', () => {
    const p = plan({
      'package.json': pkg({ typecheck: 'tsc --noEmit', test: 'node --test', build: 'tsup' }),
      'package-lock.json': '{}',
      'node_modules': '',
    });
    assert.deepEqual(names(p), ['typecheck', 'test', 'build']);
    assert.equal(p.packageManager, 'npm');
    assert.deepEqual(
      p.checks.map((c) => c.command),
      ['npm run typecheck', 'npm test', 'npm run build'],
    );
  });

  test('pnpm, yarn and bun each get their own command syntax', () => {
    assert.equal(scriptCommand('pnpm', 'typecheck'), 'pnpm run typecheck');
    assert.equal(scriptCommand('yarn', 'test'), 'yarn test');
    assert.equal(scriptCommand('bun', 'test'), 'bun run test');
    assert.equal(scriptCommand('npm', 'test'), 'npm test', 'npm test is not `npm run test`');

    const p = plan({
      'package.json': pkg({ test: 'vitest run' }),
      'pnpm-lock.yaml': '',
      'node_modules': '',
    });
    assert.equal(p.packageManager, 'pnpm');
    assert.equal(p.checks[0]!.command, 'pnpm run test');
  });

  test('no package.json means no scripts, and says so', () => {
    const p = plan({});
    assert.deepEqual(names(p), []);
    assert.match(p.unavailableReasons.join(' '), /no package\.json/);
  });

  test('a project with none of the three scripts is unavailable, not passing', () => {
    const p = plan({ 'package.json': pkg({ format: 'prettier -w .' }), 'node_modules': '' });
    assert.deepEqual(names(p), []);
    // Wording widened when qualified fallback landed: the reason now says
    // "no SAFE ... script (exact or qualified)", because a project can declare
    // a typecheck script and still end up here if it is a watcher.
    assert.match(p.unavailableReasons.join(' '), /no safe typecheck, test or build script/);
  });

  test('watch and dev-server scripts are refused', () => {
    const p = plan({
      'package.json': pkg({ test: 'vitest --watch', build: 'vite dev' }),
      'node_modules': '',
    });
    assert.deepEqual(names(p), [], 'a command that never exits must never be auto-run');
    assert.match(p.unavailableReasons.join(' '), /long-running or deploying/);
  });

  test('deploy and publish scripts are refused even when named innocently', () => {
    const p = plan({
      'package.json': pkg({ build: 'wrangler deploy', test: 'npm publish --dry-run' }),
      'node_modules': '',
    });
    assert.deepEqual(names(p), [], 'effects outside the working tree are never automatic');
  });

  test('missing node_modules makes checks unavailable rather than failing', () => {
    const p = plan({ 'package.json': pkg({ typecheck: 'tsc --noEmit' }), 'package-lock.json': '{}' });
    assert.deepEqual(names(p), []);
    assert.match(p.unavailableReasons.join(' '), /node_modules is absent/);
    assert.match(p.unavailableReasons.join(' '), /never installs/);
  });

  test('ambiguous lockfiles fall back to npm and record why', () => {
    const p = plan({
      'package.json': pkg({ test: 'node --test' }),
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
      'node_modules': '',
    });
    assert.equal(p.packageManager, 'npm');
    assert.match(p.unavailableReasons.join(' '), /multiple lockfiles/);
  });

  test('lint rides along but never stands in for a real check', () => {
    const withReal = plan({
      'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .' }),
      'node_modules': '',
    });
    assert.deepEqual(names(withReal), ['typecheck', 'lint']);
    assert.equal(withReal.checks.find((c) => c.name === 'lint')!.required, false);

    const lintOnly = plan({ 'package.json': pkg({ lint: 'eslint .' }), 'node_modules': '' });
    assert.deepEqual(names(lintOnly), [], 'lint alone is not verification');
  });

  test('a git repository contributes an ADVISORY whitespace/conflict check', () => {
    const p = buildVerificationPlan('/proj', {
      timeoutMs: 1000,
      isGitRepo: true,
      deps: fs({ 'package.json': pkg({}), 'node_modules': '' }),
    });
    const git = p.checks.find((c) => c.source === 'repository_check');
    assert.ok(git, 'git diff --check still catches conflict markers and whitespace damage');
    assert.equal(git.command, 'git diff --check');
    assert.equal(
      git.required,
      false,
      'it reports on the whole working tree and cannot tell which hunks this run produced, so it must not gate the run',
    );
  });

  test('unparseable package.json is unavailable, never a pass', () => {
    const p = plan({ 'package.json': '{ not json', 'node_modules': '' });
    assert.deepEqual(names(p), []);
    assert.match(p.unavailableReasons.join(' '), /could not be parsed/);
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** A `runCommand` stand-in driven by a per-command script. */
function fakeRun(script: Record<string, { code: number | null; out?: string; timedOut?: boolean }>) {
  const calls: string[] = [];
  const run = async (_shell: unknown, command: string) => {
    calls.push(command);
    const r = script[command];
    if (!r) throw new Error(`spawn ${command} ENOENT`);
    return {
      code: r.code,
      stdout: r.out ?? '',
      stderr: '',
      timedOut: r.timedOut ?? false,
      truncated: false,
      kill: null,
    };
  };
  return { run: run as never, calls };
}

const twoChecks: VerificationPlan = {
  checks: [
    { name: 'typecheck', command: 'npm run typecheck', cwd: '/p', source: 'package_script', required: true, timeoutMs: 100 },
    { name: 'test', command: 'npm test', cwd: '/p', source: 'package_script', required: true, timeoutMs: 100 },
  ],
  packageManager: 'npm',
  projectRoot: '/p',
  unavailableReasons: [],
};

describe('verification execution', () => {
  test('all required checks passing is a pass', async () => {
    const { run, calls } = fakeRun({ 'npm run typecheck': { code: 0 }, 'npm test': { code: 0 } });
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'passed');
    assert.equal(out.generation, 1);
    assert.deepEqual(calls, ['npm run typecheck', 'npm test']);
  });

  test('a failing typecheck fails the run and stops before the slow suite', async () => {
    // This is N7 exactly: the tests would have passed, so running them proves
    // nothing and costs time the repair turn could have used.
    const { run, calls } = fakeRun({
      'npm run typecheck': { code: 2, out: "error TS18046: 'body' is of type 'unknown'." },
      'npm test': { code: 0 },
    });
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'failed');
    assert.deepEqual(calls, ['npm run typecheck'], 'stops at the first required failure');
    assert.match(out.checks[0]!.stdout, /TS18046/);
  });

  test('a failing test suite fails even when the typecheck was clean', async () => {
    const { run } = fakeRun({ 'npm run typecheck': { code: 0 }, 'npm test': { code: 1 } });
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.checks.at(-1)!.name, 'test');
  });

  test('a timed-out check is timed_out, not passed', async () => {
    const { run } = fakeRun({ 'npm run typecheck': { code: null, timedOut: true } });
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.checks[0]!.result, 'timed_out');
  });

  test('a missing executable is unavailable, never a pass', async () => {
    const { run } = fakeRun({}); // every command throws ENOENT
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'unavailable');
    assert.equal(out.checks[0]!.result, 'unavailable');
    assert.match(out.checks[0]!.reason!, /ENOENT/);
  });

  test('an already-cancelled run runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const { run, calls } = fakeRun({ 'npm run typecheck': { code: 0 } });
    const out = await executeVerification(twoChecks, 1, { signal: ac.signal, run });
    assert.equal(out.status, 'cancelled');
    assert.deepEqual(calls, [], 'no check is dispatched after cancellation');
  });

  test('cancellation mid-check is cancelled, not failed', async () => {
    const ac = new AbortController();
    const run = (async () => {
      ac.abort();
      throw new Error('aborted');
    }) as never;
    const out = await executeVerification(twoChecks, 1, { signal: ac.signal, run });
    assert.equal(out.status, 'cancelled', 'a cancelled check must keep the cancellation reason');
  });

  test('a plan with no required checks is unavailable', async () => {
    const empty: VerificationPlan = { ...twoChecks, checks: [] };
    const out = await executeVerification(empty, 1, {
      signal: new AbortController().signal,
      run: fakeRun({}).run,
    });
    assert.equal(out.status, 'unavailable');
  });

  test('long output is truncated but keeps the tail where errors live', async () => {
    const noise = 'x'.repeat(50_000) + '\nFINAL ERROR LINE';
    const { run } = fakeRun({ 'npm run typecheck': { code: 1, out: noise } });
    const out = await executeVerification(twoChecks, 1, {
      signal: new AbortController().signal,
      run,
    });
    const captured = out.checks[0]!.stdout;
    assert.ok(captured.length < 5_000, 'bounded');
    assert.match(captured, /FINAL ERROR LINE/, 'the useful end survives');
    assert.match(captured, /truncated/);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('reporting', () => {
  test('no mutation never claims checks passed', () => {
    const m = new MutationState(2);
    assert.match(describeVerification(m.summary()), /no verification was required/i);
  });

  test('unavailable is never phrased as verified', () => {
    const m = new MutationState(2);
    m.recordMutation('a');
    m.recordVerification({ status: 'unavailable', checks: [], generation: 1 });
    const text = describeVerification(m.summary());
    assert.match(text, /could not be automatically verified/i);
    assert.doesNotMatch(text, /verified —/i);
  });

  test('the repair message carries the failure, the paths and the allowance', () => {
    const m = new MutationState(2);
    m.recordMutation('src/responses.test.ts');
    m.consumeRepair();
    const msg = buildRepairMessage(
      {
        status: 'failed',
        generation: 1,
        checks: [
          {
            name: 'typecheck',
            command: 'npm run typecheck',
            cwd: '/p',
            source: 'package_script',
            required: true,
            timeoutMs: 1,
            result: 'failed',
            exitCode: 2,
            startedAt: 0,
            endedAt: 1,
            durationMs: 1,
            stdout: "error TS18046: 'body' is of type 'unknown'.",
            stderr: '',
          },
        ],
      },
      m,
      ['src/unrelated.ts'],
    );
    assert.match(msg, /npm run typecheck/);
    assert.match(msg, /exit code: 2/);
    assert.match(msg, /TS18046/);
    assert.match(msg, /src\/responses\.test\.ts/);
    assert.match(msg, /src\/unrelated\.ts/, 'collateral paths are surfaced, not hidden');
    assert.match(msg, /Repair attempts remaining after this one: 1/);
    assert.match(msg, /Do not start unrelated work/);
  });
});

// ---------------------------------------------------------------------------
// Advisory checks (F1) and repair-path baseline (F3)
// ---------------------------------------------------------------------------

describe('advisory checks never gate the run', () => {
  const plan2 = (required: boolean): VerificationPlan => ({
    checks: [
      { name: 'typecheck', command: 'npm run typecheck', cwd: '/p', source: 'package_script', required: true, timeoutMs: 100 },
      { name: 'git diff --check', command: 'git diff --check', cwd: '/p', source: 'repository_check', required, timeoutMs: 100 },
    ],
    packageManager: 'npm',
    projectRoot: '/p',
    unavailableReasons: [],
  });

  test('a failing advisory with passing required checks still verifies', async () => {
    // The user's own unstaged whitespace fails git diff --check. Forge's work
    // is fine. Before this fix that combination failed the run and spent both
    // repair rounds on a file Forge never touched.
    const { run, calls } = fakeRun({
      'npm run typecheck': { code: 0 },
      'git diff --check': { code: 1, out: 'src/user-owned.ts:1: trailing whitespace.' },
    });
    const out = await executeVerification(plan2(false), 1, {
      signal: new AbortController().signal,
      run,
    });

    assert.equal(out.status, 'passed', 'an advisory failure cannot fail the run');
    assert.deepEqual(calls, ['npm run typecheck', 'git diff --check'], 'and it still runs');
    const git = out.checks.find((c) => c.name === 'git diff --check')!;
    assert.equal(git.result, 'failed', 'the nonzero result is retained, not discarded');
    assert.equal(git.exitCode, 1);
    assert.match(git.stdout, /user-owned/, 'and its diagnostic is kept for display');
  });

  test('a failing advisory does not stop later required checks', async () => {
    const p: VerificationPlan = {
      ...plan2(false),
      checks: [plan2(false).checks[1]!, plan2(false).checks[0]!], // advisory first
    };
    const { run, calls } = fakeRun({
      'git diff --check': { code: 1, out: 'noise' },
      'npm run typecheck': { code: 0 },
    });
    const out = await executeVerification(p, 1, { signal: new AbortController().signal, run });
    assert.equal(out.status, 'passed');
    assert.equal(calls.length, 2, 'the advisory failure did not short-circuit the plan');
  });

  test('advisory results alone can never establish verified status', async () => {
    const advisoryOnly: VerificationPlan = {
      checks: [
        { name: 'git diff --check', command: 'git diff --check', cwd: '/p', source: 'repository_check', required: false, timeoutMs: 100 },
      ],
      packageManager: null,
      projectRoot: '/p',
      unavailableReasons: ['no declared scripts'],
    };
    const { run, calls } = fakeRun({ 'git diff --check': { code: 0 } });
    const out = await executeVerification(advisoryOnly, 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'unavailable', 'a clean advisory is not verification');
    assert.deepEqual(calls, ['git diff --check'], 'it still ran and can be reported');
  });

  test('a required failure still fails even when an advisory also failed', async () => {
    const { run } = fakeRun({
      'npm run typecheck': { code: 2, out: 'error TS0001' },
      'git diff --check': { code: 1, out: 'src/user-owned.ts:1: trailing whitespace.' },
    });
    const out = await executeVerification(plan2(false), 1, {
      signal: new AbortController().signal,
      run,
    });
    assert.equal(out.status, 'failed');
    assert.equal(advisoryWarnings(out).length, 0, 'the run stopped before the advisory ran');
  });

  test('repair feedback names only required failures, never advisory paths', () => {
    const m = new MutationState(2);
    m.recordMutation('src/forge-edit.ts');
    const msg = buildRepairMessage(
      {
        status: 'failed',
        generation: 1,
        checks: [
          {
            name: 'typecheck', command: 'npm run typecheck', cwd: '/p', source: 'package_script',
            required: true, timeoutMs: 1, result: 'failed', exitCode: 2, startedAt: 0, endedAt: 1,
            durationMs: 1, stdout: 'error TS0001: in src/forge-edit.ts', stderr: '',
          },
          {
            name: 'git diff --check', command: 'git diff --check', cwd: '/p',
            source: 'repository_check', required: false, timeoutMs: 1, result: 'failed',
            exitCode: 1, startedAt: 0, endedAt: 1, durationMs: 1,
            stdout: 'src/user-owned.ts:1: trailing whitespace.', stderr: '',
          },
        ],
      },
      m,
      [],
    );
    assert.match(msg, /npm run typecheck/, 'the required failure is the repair target');
    assert.doesNotMatch(
      msg,
      /user-owned/,
      "a file the run never touched must never be handed to the model as something to fix",
    );
    assert.doesNotMatch(msg, /git diff --check/, 'advisory checks are not repair work');
  });

  test('a verified run with an advisory failure does not claim a clean repository', () => {
    const m = new MutationState(2);
    m.recordMutation('src/forge-edit.ts');
    m.recordVerification({
      status: 'passed',
      generation: 1,
      checks: [
        {
          name: 'typecheck', command: 'npm run typecheck', cwd: '/p', source: 'package_script',
          required: true, timeoutMs: 1, result: 'passed', exitCode: 0, startedAt: 0, endedAt: 1,
          durationMs: 1, stdout: '', stderr: '',
        },
        {
          name: 'git diff --check', command: 'git diff --check', cwd: '/p',
          source: 'repository_check', required: false, timeoutMs: 1, result: 'failed',
          exitCode: 1, startedAt: 0, endedAt: 1, durationMs: 1, stdout: 'ws', stderr: '',
        },
      ],
    });
    const text = describeVerification(m.summary());
    assert.match(text, /advisory warnings/i);
    assert.match(text, /unattributed working-tree/i);
    assert.doesNotMatch(text, /^Verified — /, 'not an unqualified all-clear');
  });
});

describe('repair-path baseline', () => {
  test('the first repair does not label the intended edit as collateral', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts'); // the requested change

    // Round 1: nothing has been added during a repair, because no repair has
    // happened yet. Before this fix this returned ['src/a.ts'] — telling the
    // model its own intended edit was unexplained.
    assert.deepEqual(m.pathsAddedSinceRepair(), []);

    m.consumeRepair(); // snapshot taken here
    assert.deepEqual(m.pathsAddedSinceRepair(), [], 'still nothing new right after the snapshot');
  });

  test('a path introduced during repair one is surfaced', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');
    m.consumeRepair();
    m.recordMutation('src/collateral.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), ['src/collateral.ts']);
  });

  test('the baseline advances so round two compares against round one', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');

    m.consumeRepair(); // round 1 baseline = [a]
    m.recordMutation('src/collateral.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), ['src/collateral.ts']);

    m.consumeRepair(); // round 2 baseline = [a, collateral]
    assert.deepEqual(m.pathsAddedSinceRepair(), [], 'round one damage is no longer "new"');

    m.recordMutation('src/second.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), ['src/second.ts'], 'only round two damage');
  });

  test('a fresh run starts with an empty baseline', () => {
    const m = new MutationState(2);
    assert.deepEqual(m.pathsAddedSinceRepair(), []);
    m.recordMutation('src/x.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), [], 'no repair yet, so nothing is collateral');
  });

  test('a finalized run rejects late path updates', () => {
    const m = new MutationState(2);
    m.recordMutation('src/a.ts');
    m.consumeRepair();
    m.finalize();
    m.recordMutation('src/late.ts');
    assert.deepEqual(m.pathsAddedSinceRepair(), [], 'a reported result cannot be rewritten');
  });
});
