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

/**
 * How a package script came to be selected.
 *
 * Optional so summaries written before qualified fallback existed still load —
 * an absent value means "not recorded", never "exact".
 */
export type CheckMatchType = 'exact' | 'qualified_fallback';

export interface VerificationCheck {
  name: string;
  command: string;
  cwd: string;
  source: CheckSource;
  /** Only required checks can fail a run. Optional ones are informational. */
  required: boolean;
  timeoutMs: number;
  /** Which canonical category this check satisfies (`typecheck`/`test`/…). */
  category?: string;
  matchType?: CheckMatchType;
  /** Why this script was chosen — shown so the selection can be audited. */
  selectionReason?: string;
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
  /**
   * The changed-path set as it stood when the most recent repair round began,
   * or null while no repair has happened yet.
   *
   * `null` rather than `[]` is load-bearing. With an empty array as the initial
   * value, the first repair round compared the current paths against nothing and
   * reported every INTENDED edit as unexplained collateral — telling the model
   * its own requested change was suspicious, which invites it to undo correct
   * work. Nothing can have been "added during a repair" before a repair exists.
   */
  private preRepairPaths: string[] | null = null;

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
   * Paths that appeared only after the last repair round began.
   *
   * Deliberately a set difference and nothing more: the goal is visibility into
   * blind repair damage (N8 mangled a route block nobody asked it to touch),
   * not semantic relevance scoring.
   *
   * Empty until a repair has actually been consumed — before that there is no
   * "during a repair" to be after.
   */
  pathsAddedSinceRepair(): string[] {
    if (this.preRepairPaths === null) return [];
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
        ...(c.category ? { category: c.category } : {}),
        ...(c.matchType ? { matchType: c.matchType } : {}),
        ...(c.selectionReason ? { selectionReason: c.selectionReason } : {}),
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
    /**
     * Which canonical category this satisfied, and whether the script name
     * matched exactly or stood in as a qualified variant.
     *
     * Both optional: summaries written before qualified fallback existed have
     * neither, and an absent `matchType` means "not recorded" rather than
     * "exact". Readers must not infer coverage from their absence.
     */
    category?: string;
    matchType?: CheckMatchType;
    selectionReason?: string;
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
export const CANDIDATE_SCRIPTS = ['typecheck', 'test', 'build'] as const;

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

  // Browser and end-to-end suites. Excluded from AUTOMATIC verification in
  // this slice for reasons unrelated to correctness: they need a browser
  // binary that may not be installed, they are slow enough to dominate a
  // repair cycle, and a failure usually says something about the environment
  // rather than about the model's edit. A run that cannot tell those apart
  // would spend both repair rounds chasing a missing Chromium.
  //
  // `headed` is rejected while `headless` is deliberately not: the former is
  // interactive by definition, the latter is a normal CI shape. Both still
  // have to clear the body filters, so a headless script that shells out to
  // playwright is rejected on its body regardless of its name.
  /\be2e\b/i,
  /\bend[-_]?to[-_]?end\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\bwebdriver\b/i,
  /\bselenium\b/i,
  /\bpuppeteer\b/i,
  /\bbrowser\b/i,
  /\bheaded\b/i,
];

function isForbidden(name: string, body: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(name) || re.test(body));
}

/**
 * Preferred qualifiers per category, most wanted first.
 *
 * Consulted only when no exact canonical script exists. The ordering is a
 * judgement about which variant is most likely to be the fast, deterministic,
 * CI-shaped one — `test:unit` before `test:all` because a unit suite is the
 * cheapest useful signal for a repair loop. Anything not listed still competes,
 * lexicographically, so an unusual name is ranked rather than ignored.
 */
const FALLBACK_PREFERENCE: Record<string, readonly string[]> = {
  typecheck: ['ci', 'all', 'app', 'server'],
  test: ['unit', 'ci', 'fast', 'headless', 'all'],
  build: ['ci', 'app', 'client', 'server', 'all'],
};

interface FallbackCandidate {
  name: string;
  /** 0 = `category:qualifier`, 1 = `qualifier:category`. Prefix form wins. */
  form: 0 | 1;
  rank: number;
}

/**
 * Find the one qualified script to stand in for a missing canonical one.
 *
 * Matching is on colon-delimited SEGMENTS, never substrings. `test:unit` and
 * `server:test` qualify; `contest`, `latest`, `pretest-data` and
 * `testing-server` do not, because none of them has a segment that IS the
 * category. Substring matching would have picked up all four, and running
 * `npm run contest` as a verification check is exactly the kind of surprise an
 * automatic gate must never produce.
 *
 * Selection is total-ordered and independent of key order in package.json, so
 * the same manifest always yields the same plan.
 */
export function findQualifiedFallback(
  category: string,
  scripts: Record<string, string>,
): { name: string; reason: string } | null {
  const preference = FALLBACK_PREFERENCE[category] ?? [];
  const candidates: FallbackCandidate[] = [];

  for (const [name, body] of Object.entries(scripts)) {
    const segs = name.split(':');
    if (segs.length < 2) continue;

    let form: 0 | 1;
    let qualifier: string;
    if (segs[0] === category) {
      form = 0;
      qualifier = segs.slice(1).join(':');
    } else if (segs[segs.length - 1] === category) {
      form = 1;
      qualifier = segs.slice(0, -1).join(':');
    } else {
      continue;
    }

    // A fallback earns no leniency: same name and body filters as an exact one.
    if (isForbidden(name, body)) continue;

    const idx = preference.indexOf(qualifier);
    candidates.push({ name, form, rank: idx === -1 ? Number.MAX_SAFE_INTEGER : idx });
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) => a.form - b.form || a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const winner = candidates[0]!;
  return {
    name: winner.name,
    reason: `no exact "${category}" script is declared — selected from declared qualified script ${winner.name}`,
  };
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

export interface PackageManagerDetection {
  /** Selected manager — npm when there is no lockfile or the lockfiles disagree. */
  manager: PackageManager;
  /** Lockfiles observed, in precedence order. */
  lockfilesPresent: string[];
  /** True when the present lockfiles map to more than one DISTINCT manager. */
  ambiguous: boolean;
}

/**
 * Resolve the package manager from lockfiles — the single source of truth for
 * both the verification plan and the project profile, so the two can never
 * disagree about the manager, the observed lockfiles, or ambiguity.
 *
 * Ambiguity is by DISTINCT manager, not lockfile count: two lockfiles that both
 * mean bun (`bun.lockb` + `bun.lock`) resolve cleanly to bun and are NOT
 * ambiguous. More than one distinct manager falls back to npm, the resolver
 * every Node install can run, rather than guessing a winner.
 */
export function detectPackageManager(
  cwd: string,
  deps: Pick<PlanDeps, 'exists'>,
): PackageManagerDetection {
  const found = LOCKFILES.filter((l) => deps.exists(join(cwd, l.file)));
  const lockfilesPresent = found.map((l) => l.file);
  const managers = new Set(found.map((l) => l.manager));
  if (managers.size === 1) return { manager: found[0]!.manager, lockfilesPresent, ambiguous: false };
  return { manager: 'npm', lockfilesPresent, ambiguous: managers.size > 1 };
}

export type DeclaredCheckReadiness =
  | 'runnable'
  | 'unavailable_missing_dependencies'
  | 'unavailable_unsupported_command'
  | 'unknown';

/**
 * Decide whether a selected declared script can actually run.
 *
 * Daily-use finding 001: a zero-dependency project declaring `test: node --test`
 * was marked unavailable purely because node_modules did not exist — a false
 * negative, since a direct `node` invocation needs no installed packages. The
 * narrow rule: with node_modules present, everything selected is runnable
 * (unchanged semantics); without it, ONLY a script that (a) belongs to a
 * package declaring no dependencies of any kind and (b) invokes the node
 * runtime directly — first token exactly `node`, no shell composition, no
 * substitution, no npx/package binaries — is runnable. Everything else keeps
 * the honest unavailable classification. Deterministic; never executes the
 * command to find out.
 */
export function classifyDeclaredCheckReadiness(opts: {
  scriptBody: string;
  hasNodeModules: boolean;
  declaresDependencies: boolean;
}): DeclaredCheckReadiness {
  if (opts.hasNodeModules) return 'runnable';
  if (opts.declaresDependencies) return 'unavailable_missing_dependencies';

  const body = opts.scriptBody.trim();
  if (body === '') return 'unknown';
  // Reject any shell composition, redirection, or substitution outright —
  // conservative on purpose: a composed command may reach package binaries.
  if (/[&|;<>`$()\r\n]/.test(body)) return 'unavailable_unsupported_command';
  const first = body.split(/\s+/, 1)[0];
  if (first !== 'node') return 'unavailable_unsupported_command';
  return 'runnable';
}

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
  // `git diff --check` catches conflict markers and whitespace errors, which is
  // the cheapest signal for the N8 damage class. It is ADVISORY, not a gate.
  //
  // It reports on the whole working diff, and cannot tell which hunks this run
  // produced. Treating it as required meant a user's own unstaged trailing
  // whitespace failed a correct run, burned both repair rounds, and handed the
  // model the user's file to "fix" — a false failure in the most ordinary
  // development state there is. Until attribution is scoped to the run's own
  // changes, this reports and never blocks.
  if (opts.isGitRepo ?? deps.exists(join(cwd, '.git'))) {
    checks.push({
      name: 'git diff --check',
      command: 'git diff --check',
      cwd,
      source: 'repository_check',
      required: false,
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
  let declaresDependencies = true;
  try {
    const parsed = JSON.parse(deps.readFile(pkgPath)) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    scripts = parsed.scripts ?? {};
    declaresDependencies = [
      parsed.dependencies,
      parsed.devDependencies,
      parsed.optionalDependencies,
      parsed.peerDependencies,
    ].some((d) => d !== undefined && Object.keys(d).length > 0);
  } catch {
    unavailable.push('package.json could not be parsed — no declared scripts to run');
    return { checks, packageManager: null, projectRoot: cwd, unavailableReasons: unavailable };
  }

  const pm = detectPackageManager(cwd, deps);
  const manager = pm.manager;
  if (pm.ambiguous) {
    // Ambiguous: fall back to the universally available resolver rather than
    // picking a winner and running the wrong one.
    unavailable.push(
      `multiple lockfiles present (${pm.lockfilesPresent.join(', ')}) — defaulting to npm`,
    );
  }

  // Dependencies are never installed automatically. Without node_modules a
  // script that needs installed packages would fail for a reason that has
  // nothing to do with the model's change, and reporting that as a
  // verification failure would be a lie. Dependency-free direct-node scripts
  // are the exception — classifyDeclaredCheckReadiness decides per script.
  const hasModules = deps.exists(join(cwd, 'node_modules'));

  /** One entry per category, in run order. Never two from the same category. */
  const selected: Array<{
    name: string;
    category: string;
    matchType: CheckMatchType;
    reason?: string;
  }> = [];

  for (const category of CANDIDATE_SCRIPTS) {
    const body = scripts[category];

    // Exact wins outright. A declared `test` is what the project means by
    // testing; a qualified variant must never displace it, and only ever one
    // command per category is selected.
    if (body !== undefined && !isForbidden(category, body)) {
      selected.push({ name: category, category, matchType: 'exact' });
      continue;
    }
    if (body !== undefined) {
      unavailable.push(
        `script "${category}" skipped — it looks like a long-running or deploying task`,
      );
      // An unsafe exact script does not block a safe qualified one: the project
      // may well declare `test` as a watcher and `test:unit` as the real suite.
    }

    const fallback = findQualifiedFallback(category, scripts);
    if (fallback) {
      selected.push({
        name: fallback.name,
        category,
        matchType: 'qualified_fallback',
        reason: fallback.reason,
      });
    }
  }

  for (const name of OPTIONAL_SCRIPTS) {
    const body = scripts[name];
    if (body === undefined) continue;
    if (isForbidden(name, body)) continue;
    // Lint never displaces a real check; it rides along only when one exists.
    if (selected.length === 0) continue;
    selected.push({ name, category: name, matchType: 'exact' });
  }

  if (selected.length === 0) {
    unavailable.push(
      'package.json declares no safe typecheck, test or build script (exact or qualified)',
    );
  }

  for (const s of selected) {
    const readiness = classifyDeclaredCheckReadiness({
      scriptBody: scripts[s.name] ?? '',
      hasNodeModules: hasModules,
      declaresDependencies,
    });
    if (readiness !== 'runnable') {
      unavailable.push(
        readiness === 'unavailable_unsupported_command' || readiness === 'unknown'
          ? `script "${s.name}" cannot run — node_modules is absent and its command is not a direct node invocation`
          : `script "${s.name}" cannot run — node_modules is absent and forge never installs`,
      );
      continue;
    }
    checks.push({
      name: s.name,
      command: scriptCommand(manager, s.name),
      cwd,
      source: 'package_script',
      // Lint is advisory; the rest gate the run.
      required: !OPTIONAL_SCRIPTS.includes(s.category as (typeof OPTIONAL_SCRIPTS)[number]),
      timeoutMs,
      category: s.category,
      matchType: s.matchType,
      ...(s.reason ? { selectionReason: s.reason } : {}),
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

  const hasRequired = plan.checks.some((c) => c.required);

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

  // With no required check there is nothing that could establish correctness.
  // An advisory result alone must never read as verified — it is reported, and
  // the run is still "changed but not verified".
  if (!hasRequired) {
    return { status: 'unavailable', checks: outcomes, generation };
  }

  const anyRequiredFailed = outcomes.some((o) => o.required && o.result !== 'passed');
  return { status: anyRequiredFailed ? 'failed' : 'passed', checks: outcomes, generation };
}

/** Advisory checks that came back non-passing. Never gates, always reported. */
export function advisoryWarnings(outcome: VerificationOutcome | null): CheckOutcome[] {
  return (outcome?.checks ?? []).filter((c) => !c.required && c.result !== 'passed');
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
  // ONLY required failures. Advisory results — notably `git diff --check`,
  // which reports on the whole working tree — are deliberately withheld here:
  // their output names files this run may never have touched, and putting them
  // under "fix only what is reported here" is how the model ends up editing the
  // user's own uncommitted work. They belong in the final summary instead.
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
      const names = summary.checks
        .filter((c) => c.required && c.result === 'passed')
        .map((c) => c.name);
      const advisory = summary.checks.filter((c) => !c.required && c.result !== 'passed');
      const base = `Verified — ${names.join(', ') || 'all required checks'} passed.`;
      if (advisory.length === 0) return base;
      // Never claim an entirely clean repository on the strength of the
      // required checks alone: the advisory result is real information, it just
      // cannot be attributed to this run.
      return `Verified with advisory warnings — required checks passed; ${advisory
        .map((c) => c.name)
        .join(', ')} reported existing or unattributed working-tree issues.`;
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
