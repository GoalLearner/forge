/**
 * Post-edit verification.
 *
 * Dogfooding Benchmark v1 found one dominant failure mode, twice. In N7 Forge
 * wrote a feature and ten tests, ran the tests, watched them pass, and declared
 * success — leaving the project's `tsc --noEmit` broken with six new errors from
 * a baseline that had been clean. In N8 an edit failed, blind retries mangled an
 * unrelated route block, and nothing noticed until the step ceiling fired.
 *
 * Both have the same root: Forge knew when it had STOPPED, but had no notion of
 * whether what it wrote was CORRECT. It only ran the checks the model happened
 * to think of.
 *
 * This module supplies the missing half. After the model stops, if project files
 * actually changed, Forge runs the project's OWN declared checks and refuses to
 * call the run a success until they pass. The enforcement lives in the loop, not
 * in the prompt, so the model cannot skip it by not thinking of it.
 *
 * Three deliberate limits keep this a verification feature rather than a
 * repository-intelligence system:
 *
 *   - Only DECLARED scripts run. Nothing is invented, nothing is installed.
 *   - Anything that looks like a server, a watcher or a deployment is refused.
 *   - The repair loop is bounded to a small fixed allowance, and `maxSteps` /
 *     `maxRuntimeMs` remain hard ceilings above it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand, resolveShell, type ShellSpec } from '../tools/shell.ts';

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * Where a run stands with respect to verification.
 *
 * `not_required` and `unavailable` are NOT the same thing and must never be
 * collapsed: the first means nothing changed so there was nothing to check, the
 * second means something changed and we could not check it. Reporting the
 * second as success is the exact dishonesty this module exists to prevent.
 */
export type VerificationStatus =
  | 'not_required'
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'cancelled';

/** Outcome of one individual check. */
export type CheckResult =
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'cancelled'
  | 'timed_out'
  | 'skipped';

/** Where a check came from — used in reporting so the user can audit it. */
export type CheckSource = 'package_script' | 'repository_check' | 'project_configuration';

export interface VerificationCheck {
  name: string;
  command: string;
  cwd: string;
  source: CheckSource;
  /** Only required checks can fail a run. Optional ones are informational. */
  required: boolean;
  timeoutMs: number;
}

export interface CheckOutcome extends VerificationCheck {
  result: CheckResult;
  exitCode: number | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Present for skipped/unavailable — says WHY, so it is never mistaken for a pass. */
  reason?: string;
}

export interface VerificationPlan {
  checks: VerificationCheck[];
  /** Package manager selected from the lockfile, when a JS project was found. */
  packageManager: PackageManager | null;
  projectRoot: string | null;
  /** Populated when no usable checks could be built — surfaced to the user. */
  unavailableReasons: string[];
}

export interface VerificationOutcome {
  status: Extract<VerificationStatus, 'passed' | 'failed' | 'unavailable' | 'cancelled'>;
  checks: CheckOutcome[];
  /** Which mutation generation this verdict describes. */
  generation: number;
}

/**
 * Repair rounds allowed per submitted prompt.
 *
 * A fixed internal constant rather than a config knob for v1: two rounds cover
 * the failure this was built for — one precise check failure, one targeted fix
 * — and `maxSteps` / `maxRuntimeMs` already sit above it as hard ceilings.
 * Adding a setting before anyone has wanted a different value would be a knob
 * nobody can calibrate.
 */
export const MAX_VERIFICATION_REPAIRS = 2;

// ---------------------------------------------------------------------------
// Mutation generation
// ---------------------------------------------------------------------------

/**
 * Whether this run has touched the project, and whether that state has been
 * verified.
 *
 * The generation counter is what makes a stale pass impossible. Verification is
 * recorded against the exact generation it observed; any later mutation bumps
 * the counter, and `needsVerification()` compares the two rather than trusting a
 * boolean. A run that edits, verifies, then edits again therefore cannot finish
 * on the strength of the first pass.
 *
 * Mutation is recorded from TOOL EVIDENCE — a write tool that returned without
 * an error — never from the model claiming in prose that it edited something.
 */
export class MutationState {
  private gen = 0;
  private verifiedGen: number | null = null;
  private paths = new Set<string>();
  private state: VerificationStatus = 'not_required';
  private repairs = 0;
  private frozen = false;
  private last: VerificationOutcome | null = null;
  /** Paths already changed when the most recent repair round began. */
  private preRepairPaths: string[] = [];

  /**
   * Declared as a field rather than a constructor parameter property: Node runs
   * this TypeScript in strip-only mode, which rejects parameter properties.
   */
  readonly maxRepairs: number;

  constructor(maxRepairs: number) {
    this.maxRepairs = maxRepairs;
  }

  get generation(): number {
    return this.gen;
  }

  get status(): VerificationStatus {
    return this.state;
  }

  get repairsUsed(): number {
    return this.repairs;
  }

  get repairsRemaining(): number {
    return Math.max(0, this.maxRepairs - this.repairs);
  }

  get lastOutcome(): VerificationOutcome | null {
    return this.last;
  }

  changedPaths(): string[] {
    return [...this.paths].sort();
  }

  /**
   * Record a mutation that actually happened.
   *
   * `path` is optional because not every mutating tool reports one (a shell
   * command may have written anything). The generation still moves: a mutation
   * we cannot describe is still a mutation, and must still invalidate any
   * earlier pass.
   */
  recordMutation(path?: string): void {
    if (this.frozen) return;
    this.gen += 1;
    if (path) this.paths.add(path);
    // Any prior verdict described an older tree and is now meaningless.
    this.state = 'pending';
  }

  /** True when the current tree has changed and has not been verified as-is. */
  needsVerification(): boolean {
    return this.gen > 0 && this.verifiedGen !== this.gen;
  }

  beginVerification(): void {
    if (this.frozen) return;
    this.state = 'running';
  }

  /**
   * Attach a verdict to the generation it actually observed.
   *
   * If the tree moved while checks were running, the verdict is recorded but
   * NOT credited to the current generation — so completion stays gated and the
   * checks run again.
   */
  recordVerification(outcome: VerificationOutcome): void {
    if (this.frozen) return;
    this.last = outcome;
    this.state = outcome.status;
    if (outcome.status === 'passed' && outcome.generation === this.gen) {
      this.verifiedGen = outcome.generation;
    }
  }

  /** True when a repair round is still available. */
  canRepair(): boolean {
    return !this.frozen && this.repairs < this.maxRepairs;
  }

  /**
   * Spend one repair round. The INITIAL verification never calls this — only a
   * model turn requested because checks failed does, which is what keeps
   * "verify, fix, verify" at one round rather than two.
   */
  consumeRepair(): boolean {
    if (!this.canRepair()) return false;
    this.repairs += 1;
    this.preRepairPaths = this.changedPaths();
    return true;
  }

  /**
   * Paths that appeared only after the last repair began.
   *
   * Deliberately a set difference and nothing more: the goal is visibility into
   * blind repair damage (N8 mangled a route block nobody asked it to touch),
   * not semantic relevance scoring.
   */
  pathsAddedSinceRepair(): string[] {
    const before = new Set(this.preRepairPaths);
    return this.changedPaths().filter((p) => !before.has(p));
  }

  /** Freeze at run end so a late event cannot rewrite a reported verdict. */
  finalize(): void {
    this.frozen = true;
  }

  get finalized(): boolean {
    return this.frozen;
  }

  summary(): VerificationSummary {
    return {
      status: this.state,
      generation: this.gen,
      verifiedGeneration: this.verifiedGen,
      repairsUsed: this.repairs,
      repairAllowance: this.maxRepairs,
      changedPaths: this.changedPaths(),
      checks: (this.last?.checks ?? []).map((c) => ({
        name: c.name,
        command: c.command,
        source: c.source,
        required: c.required,
        result: c.result,
        exitCode: c.exitCode,
        durationMs: c.durationMs,
        ...(c.reason ? { reason: c.reason } : {}),
      })),
    };
  }
}

/** The persisted shape. Everything a later reader needs to audit a run. */
export interface VerificationSummary {
  status: VerificationStatus;
  generation: number;
  verifiedGeneration: number | null;
  repairsUsed: number;
  repairAllowance: number;
  changedPaths: string[];
  checks: Array<{
    name: string;
    command: string;
    source: CheckSource;
    required: boolean;
    result: CheckResult;
    exitCode: number | null;
    durationMs: number;
    reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Plan discovery
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Lockfile → package manager. Ordered most-specific first.
 *
 * When several lockfiles are present the project is ambiguous, and guessing
 * wrong means running the wrong resolver against the wrong tree. The
 * conservative answer is npm, which is the one every Node install can run.
 */
const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
];

/**
 * Scripts we will consider, in the order they should run.
 *
 * Cheapest and most diagnostic first: a typecheck failure is precise and fast,
 * so finding it before a slow test suite gives the model a better repair signal
 * for less time and less money.
 */
const CANDIDATE_SCRIPTS = ['typecheck', 'test', 'build'] as const;

/** Considered only after the three above, and never in their place. */
const OPTIONAL_SCRIPTS = ['lint'] as const;

/**
 * Script names and bodies that must never be auto-run.
 *
 * Matched against the script NAME and its BODY, because a script called
 * `verify` that shells out to `wrangler deploy` is a deployment however it is
 * labelled. Everything here either never terminates or has effects outside the
 * working tree — the two things an automatic checker must not do.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bwatch\b/i,
  /--watch\b/i,
  /\bnodemon\b/i,
  /\bserve\b/i,
  /\bdev\b/i,
  /\bstart\b/i,
  /\bdeploy\b/i,
  /\bpublish\b/i,
  /\brelease\b/i,
  /\bmigrat/i,
  /\bseed\b/i,
  /\bdrop\b/i,
  /\breset\b/i,
  /\bprune\b/i,
  /\bwrangler\s+(deploy|publish)\b/i,
  /\bnpm\s+publish\b/i,
  /\bgit\s+push\b/i,
  /\brm\s+-rf\b/i,
  /\bprod(uction)?\b/i,
];

function isForbidden(name: string, body: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(name) || re.test(body));
}

/** `npm test` is special-cased; everything else goes through `run`. */
export function scriptCommand(manager: PackageManager, script: string): string {
  if (manager === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  return `bun run ${script}`;
}

interface PlanDeps {
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
}

const REAL_DEPS: PlanDeps = {
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
};

/**
 * Build the verification plan for `cwd`.
 *
 * Deterministic and side-effect free: it reads package.json and looks for
 * lockfiles, and does nothing else. No install, no network, no writes.
 */
export function buildVerificationPlan(
  cwd: string,
  opts: { timeoutMs: number; isGitRepo?: boolean; deps?: PlanDeps } = { timeoutMs: 120_000 },
): VerificationPlan {
  const deps = opts.deps ?? REAL_DEPS;
  const checks: VerificationCheck[] = [];
  const unavailable: string[] = [];
  const timeoutMs = opts.timeoutMs;

  // --- repository checks -------------------------------------------------
  // `git diff --check` is the cheapest possible catch for the N8 damage class:
  // conflict markers and whitespace errors introduced by a mangled edit. It
  // reads the working diff only and changes nothing.
  if (opts.isGitRepo ?? deps.exists(join(cwd, '.git'))) {
    checks.push({
      name: 'git diff --check',
      command: 'git diff --check',
      cwd,
      source: 'repository_check',
      required: true,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
  }

  // --- package scripts ---------------------------------------------------
  const pkgPath = join(cwd, 'package.json');
  if (!deps.exists(pkgPath)) {
    unavailable.push('no package.json in the project root — no declared scripts to run');
    return { checks, packageManager: null, projectRoot: null, unavailableReasons: unavailable };
  }

  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(deps.readFile(pkgPath)) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    unavailable.push('package.json could not be parsed — no declared scripts to run');
    return { checks, packageManager: null, projectRoot: cwd, unavailableReasons: unavailable };
  }

  const found = LOCKFILES.filter((l) => deps.exists(join(cwd, l.file)));
  const managers = new Set(found.map((l) => l.manager));
  let manager: PackageManager = 'npm';
  if (managers.size === 1) {
    manager = found[0]!.manager;
  } else if (managers.size > 1) {
    // Ambiguous: fall back to the universally available resolver rather than
    // picking a winner and running the wrong one.
    unavailable.push(
      `multiple lockfiles present (${found.map((f) => f.file).join(', ')}) — defaulting to npm`,
    );
  }

  // Dependencies are never installed automatically. Without node_modules a
  // script would fail for a reason that has nothing to do with the model's
  // change, and reporting that as a verification failure would be a lie.
  const hasModules = deps.exists(join(cwd, 'node_modules'));

  const selected: string[] = [];
  for (const name of CANDIDATE_SCRIPTS) {
    const body = scripts[name];
    if (body === undefined) continue;
    if (isForbidden(name, body)) {
      unavailable.push(`script "${name}" skipped — it looks like a long-running or deploying task`);
      continue;
    }
    selected.push(name);
  }

  for (const name of OPTIONAL_SCRIPTS) {
    const body = scripts[name];
    if (body === undefined) continue;
    if (isForbidden(name, body)) continue;
    // Lint never displaces a real check; it rides along only when one exists.
    if (selected.length === 0) continue;
    selected.push(name);
  }

  if (selected.length === 0) {
    unavailable.push('package.json declares no typecheck, test or build script');
  }

  for (const name of selected) {
    if (!hasModules) {
      unavailable.push(`script "${name}" cannot run — node_modules is absent and forge never installs`);
      continue;
    }
    checks.push({
      name,
      command: scriptCommand(manager, name),
      cwd,
      source: 'package_script',
      // Lint is advisory; the rest gate the run.
      required: !OPTIONAL_SCRIPTS.includes(name as (typeof OPTIONAL_SCRIPTS)[number]),
      timeoutMs,
    });
  }

  return { checks, packageManager: manager, projectRoot: cwd, unavailableReasons: unavailable };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Keep failure output useful but never let a check flood the context. */
const OUTPUT_CAP = 4_000;

function tail(text: string, cap = OUTPUT_CAP): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= cap) return trimmed;
  return `…[truncated]\n${trimmed.slice(-cap)}`;
}

export interface ExecuteOpts {
  signal: AbortSignal;
  shell?: ShellSpec;
  /** Injected in tests; production uses the real Stage 0 shell path. */
  run?: typeof runCommand;
  now?: () => number;
}

/**
 * Run a plan's checks in order, stopping at the first required failure.
 *
 * Stopping early is deliberate: once a required check fails the run cannot
 * succeed, and continuing would spend time and give the model a noisier repair
 * signal than the single precise failure it needs.
 *
 * Execution goes through `runCommand` — the same path the shell tool uses — so
 * verification inherits abort propagation, the timeout, Windows process-tree
 * termination, output capping and settlement rather than reimplementing them.
 */
export async function executeVerification(
  plan: VerificationPlan,
  generation: number,
  opts: ExecuteOpts,
): Promise<VerificationOutcome> {
  const run = opts.run ?? runCommand;
  const now = opts.now ?? Date.now;
  const shell = opts.shell ?? resolveShell({ kind: 'auto' });
  const outcomes: CheckOutcome[] = [];

  const required = plan.checks.filter((c) => c.required);
  if (required.length === 0) {
    return { status: 'unavailable', checks: outcomes, generation };
  }

  for (const check of plan.checks) {
    if (opts.signal.aborted) {
      outcomes.push(blank(check, now(), 'cancelled', 'run was cancelled before this check ran'));
      return { status: 'cancelled', checks: outcomes, generation };
    }

    const startedAt = now();
    try {
      const res = await run(shell, check.command, {
        cwd: check.cwd,
        timeoutMs: check.timeoutMs,
        signal: opts.signal,
        maxBytes: OUTPUT_CAP * 4,
      });
      const endedAt = now();
      const result: CheckResult = res.timedOut ? 'timed_out' : res.code === 0 ? 'passed' : 'failed';
      outcomes.push({
        ...check,
        result,
        exitCode: res.code,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        stdout: tail(res.stdout),
        stderr: tail(res.stderr),
      });
      if (result !== 'passed' && check.required) {
        return { status: 'failed', checks: outcomes, generation };
      }
    } catch (err) {
      const endedAt = now();
      // An abort surfaces as a throw from the shared shell path; that is a
      // cancellation, not a failing check, and must keep its own reason.
      if (opts.signal.aborted) {
        outcomes.push(blank(check, startedAt, 'cancelled', 'cancelled while running'));
        return { status: 'cancelled', checks: outcomes, generation };
      }
      outcomes.push({
        ...check,
        result: 'unavailable',
        exitCode: null,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        stdout: '',
        stderr: '',
        reason: (err as Error).message,
      });
      if (check.required) {
        return { status: 'unavailable', checks: outcomes, generation };
      }
    }
  }

  const anyRequiredFailed = outcomes.some((o) => o.required && o.result !== 'passed');
  return { status: anyRequiredFailed ? 'failed' : 'passed', checks: outcomes, generation };
}

function blank(
  check: VerificationCheck,
  at: number,
  result: CheckResult,
  reason: string,
): CheckOutcome {
  return {
    ...check,
    result,
    exitCode: null,
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    stdout: '',
    stderr: '',
    reason,
  };
}

// ---------------------------------------------------------------------------
// Feedback to the model
// ---------------------------------------------------------------------------

/**
 * The repair prompt.
 *
 * Bounded on purpose: the failing command, its exit code, the tail of its
 * output, and what changed. No transcript replay, no full logs, and nothing the
 * model could not have discovered itself — a repair turn should cost roughly one
 * failing command's worth of context, not a second copy of the session.
 */
export function buildRepairMessage(
  outcome: VerificationOutcome,
  state: MutationState,
  extraPaths: string[],
): string {
  const failed = outcome.checks.filter((c) => c.result !== 'passed' && c.required);
  const lines: string[] = [];

  lines.push(
    'Automatic post-edit verification ran the project’s own checks against your changes and they did not pass. Fix only what is reported here.',
  );
  lines.push('');

  for (const c of failed) {
    lines.push(`FAILED: ${c.name}`);
    lines.push(`  command: ${c.command}`);
    lines.push(`  exit code: ${c.exitCode === null ? 'none' : c.exitCode}`);
    if (c.reason) lines.push(`  reason: ${c.reason}`);
    const body = [c.stdout, c.stderr].filter(Boolean).join('\n').trim();
    if (body) {
      lines.push('  output:');
      for (const l of tail(body, 2_000).split('\n')) lines.push(`    ${l}`);
    }
    lines.push('');
  }

  const changed = state.changedPaths();
  lines.push(`Files changed so far in this run (${changed.length}):`);
  for (const p of changed.slice(0, 40)) lines.push(`  ${p}`);
  if (changed.length > 40) lines.push(`  …and ${changed.length - 40} more`);

  if (extraPaths.length > 0) {
    lines.push('');
    lines.push(
      `These paths changed during the last repair and were not part of the original edit set — confirm they were intended: ${extraPaths.join(', ')}`,
    );
  }

  lines.push('');
  lines.push(`Mutation generation: ${state.generation}.`);
  // The round being requested has already been deducted by `consumeRepair`, so
  // `repairsRemaining` is what is left AFTER this attempt — no second subtraction.
  lines.push(`Repair attempts remaining after this one: ${state.repairsRemaining}.`);
  lines.push(
    'Diagnose the failures above and apply the smallest correct fix. Do not start unrelated work. The checks will run again automatically.',
  );

  return lines.join('\n');
}

/** One-line human summary used by every front end. */
export function describeVerification(summary: VerificationSummary): string {
  switch (summary.status) {
    case 'not_required':
      return 'No project files changed — no verification was required.';
    case 'passed': {
      const names = summary.checks.filter((c) => c.result === 'passed').map((c) => c.name);
      return `Verified — ${names.join(', ') || 'all checks'} passed.`;
    }
    case 'failed': {
      const bad = summary.checks.filter((c) => c.required && c.result !== 'passed');
      return `Verification failed — ${bad.map((c) => `${c.name} (${c.result})`).join(', ')}.`;
    }
    case 'unavailable':
      return 'Files were changed but could not be automatically verified.';
    case 'cancelled':
      return 'Verification was cancelled before it finished.';
    case 'running':
      return 'Verifying…';
    case 'pending':
      return 'Verification pending.';
  }
}
