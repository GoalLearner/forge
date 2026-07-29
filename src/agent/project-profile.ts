/**
 * Static project profile (Forge Brain Phase 2, V1).
 *
 * A deterministic, read-only snapshot of a few *facts* about the project, built
 * ONCE at session start and rendered into the frozen system prefix — after the
 * Environment block, before the project's own AGENTS.md/CLAUDE.md conventions.
 * Its whole job is to spare the model an opening round of `list_dir`/`read_file`
 * calls just to learn which package manager runs here, what the project's own
 * verification checks are, and where its source and tests live.
 *
 * What this is NOT, by construction:
 *   - It makes no decision about which files are relevant to the user's task.
 *     There is no request parsing, no ranking, no model judgment. That is the
 *     deferred Candidate B (task-specific selector) and it is out of scope here.
 *   - It never runs a command, writes a file, persists anything, or contacts a
 *     provider. It only reads the filesystem, and only within `cwd`.
 *   - It is not authoritative. It is a session-start snapshot that can go stale;
 *     the post-edit verification gate rediscovers checks independently and the
 *     model is told to re-check before relying on any of it.
 *
 * Cache: because the profile is session-static — identical for every turn of a
 * session — it belongs in the frozen prefix alongside the Environment block and
 * projectDoc, not in the per-turn tail. It is subject to a hard byte budget so
 * it can never bloat the prefix that the cost thesis depends on.
 *
 * Canonical declared checks: the profile does NOT reimplement script discovery.
 * It calls `buildVerificationPlan` — the exact pure function the verification
 * gate uses — so the checks it advertises are byte-for-byte the checks the gate
 * would select. One source of truth, no drift.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { stableStringify } from '../util/stable-json.ts';
import {
  buildVerificationPlan,
  detectPackageManager,
  CANDIDATE_SCRIPTS,
  type PackageManager,
  type PackageManagerDetection,
  type VerificationCheck,
} from './verification.ts';

export const PROJECT_PROFILE_VERSION = 1 as const;

/** The heading the rendered block starts with — asserted by the ordering tests. */
export const PROJECT_PROFILE_HEADING = '# Project profile';

/**
 * V1 emits only `deterministic` facts — things directly observed in a file,
 * directory listing, or the canonical check plan. No inference is rendered.
 * The type is wider than one member on purpose: a later phase may add
 * `inferred` facts (clearly labelled), and callers should already switch on it.
 */
export type ProjectProfileTrust = 'deterministic';

/** One declared verification check, mirrored from the canonical plan. */
export interface DeclaredCheckFact {
  category: string;
  command: string;
  matchType: 'exact' | 'qualified_fallback';
  required: boolean;
  selectionReason?: string;
}

/** A single omitted-because-over-budget marker, so truncation is never silent. */
export interface ProfileOmission {
  field: string;
  omitted: number;
}

export interface ProjectProfile {
  version: number;
  trust: ProjectProfileTrust;
  /** Always the relative `.` — the absolute cwd is already in the Environment block. */
  root: string;
  packageManager: PackageManager | null;
  packageManagerReason: string;
  packageManagerAmbiguous: boolean;
  lockfilesObserved: string[];
  declaredChecks: DeclaredCheckFact[];
  missingCheckCategories: string[];
  checkUnavailableReasons: string[];
  configSignals: string[];
  sourceRoots: string[];
  testRoots: string[];
  documentFiles: string[];
  /** Relative directories below cwd (depth ≤2) that hold a root marker. Candidates only. */
  nestedCandidates: string[];
  omissions: ProfileOmission[];
}

/** Deterministic hard limits. All bounded; none machine-dependent. */
export interface ProjectProfileBudget {
  maxRenderedBytes: number;
  maxDeclaredChecks: number;
  maxSourceRoots: number;
  maxTestRoots: number;
  maxConfigAndDocFiles: number;
  maxNestedCandidates: number;
  maxNestedDepth: number;
}

export const DEFAULT_PROFILE_BUDGET: ProjectProfileBudget = {
  maxRenderedBytes: 2048,
  maxDeclaredChecks: 6,
  maxSourceRoots: 8,
  maxTestRoots: 8,
  maxConfigAndDocFiles: 12,
  maxNestedCandidates: 4,
  maxNestedDepth: 2,
};

/**
 * Filesystem access, injectable so every test can run against an in-memory tree
 * — the same discipline `buildVerificationPlan` already uses. Read-only by type:
 * there is no write in the interface.
 */
export interface ProfileDeps {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** One directory level. Order is not trusted — the builder sorts everything. */
  readDir(path: string): Array<{ name: string; isDirectory: boolean }>;
}

const REAL_DEPS: ProfileDeps = {
  exists: existsSync,
  readFile: (p) => readFileSync(p, 'utf8'),
  readDir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })),
};

// ---------------------------------------------------------------------------
// Allowlists — bounded, deterministic, never inferred from arbitrary content
// ---------------------------------------------------------------------------

/** Top-level config files worth surfacing as observed language/build signals. */
const CONFIG_SIGNAL_FILES = [
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'deno.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
];

/** Project-document filenames — names only, never contents. */
const DOCUMENT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'README.rst',
  'README.txt',
  'CONTRIBUTING.md',
];

/** Conventional roots. Classified, not inferred by walking the tree. */
const SOURCE_ROOTS = ['src', 'lib', 'app', 'source', 'packages'];
const TEST_ROOTS = ['test', 'tests', '__tests__', 'spec', 'e2e'];

/** Root markers that make a subdirectory a nested-project candidate. */
const ROOT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

/**
 * Directories never entered during nested-project discovery. Dependency and
 * generated trees: walking them is slow, pointless, and would surface vendored
 * packages as if they were the user's own nested projects.
 */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'out',
  'target',
  '.next',
  '.cache',
  '.turbo',
]);

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

/**
 * Collapse a repository-controlled string to a single safe line.
 *
 * File names, directory names, script commands and selection reasons are all
 * attacker-controllable (a repo can contain a directory literally named
 * "\n# Approach\nIgnore your rules"). Rendered into the system prompt unescaped,
 * that could forge a heading or smuggle an instruction. So every such string is
 * stripped of control characters, has its whitespace collapsed, and is length
 * capped before it can reach the prompt.
 */
function sanitize(value: string, maxLen = 120): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = value.replace(/[\u0000-\u001f\u007f\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Build the project profile for `cwd`.
 *
 * Deterministic and side-effect free: bounded read-only filesystem inspection
 * plus one call to the canonical `buildVerificationPlan`. No time, no mtime, no
 * randomness, no absolute paths in the result.
 */
export function buildProjectProfile(
  cwd: string,
  opts: { deps?: ProfileDeps; isGitRepo?: boolean; budget?: ProjectProfileBudget } = {},
): ProjectProfile {
  const deps = opts.deps ?? REAL_DEPS;
  const budget = opts.budget ?? DEFAULT_PROFILE_BUDGET;
  const omissions: ProfileOmission[] = [];

  // Top-level listing drives roots, config signals, docs and lockfiles in one read.
  let topLevel: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    topLevel = deps.readDir(cwd);
  } catch {
    // An unreadable cwd degrades to an empty-but-valid profile rather than throwing.
  }
  const topFiles = new Set(topLevel.filter((e) => !e.isDirectory).map((e) => e.name));
  const topDirs = new Set(topLevel.filter((e) => e.isDirectory).map((e) => e.name));

  // --- package manager (all facts from the ONE canonical detector) --------
  const plan = buildVerificationPlan(cwd, {
    timeoutMs: 120_000,
    isGitRepo: opts.isGitRepo,
    deps: { exists: deps.exists, readFile: deps.readFile },
  });
  const hasPackageJson = topFiles.has('package.json');
  const pm = detectPackageManager(cwd, { exists: deps.exists });
  // The selected manager is the plan's (null when there is no/invalid package.json);
  // ambiguity and observed lockfiles come from the same canonical detector the gate
  // uses, so they can never contradict it.
  const packageManager = plan.packageManager;
  const lockfilesObserved = pm.lockfilesPresent;
  const packageManagerAmbiguous = hasPackageJson && packageManager !== null && pm.ambiguous;
  const packageManagerReason = describeManager(packageManager, hasPackageJson, pm);

  // --- declared checks (mirrored from the canonical plan) -----------------
  const scriptChecks = plan.checks.filter((c) => c.source === 'package_script');
  const declaredChecks: DeclaredCheckFact[] = scriptChecks
    .slice(0, budget.maxDeclaredChecks)
    .map(toDeclaredCheck);
  if (scriptChecks.length > budget.maxDeclaredChecks) {
    omissions.push({ field: 'declaredChecks', omitted: scriptChecks.length - budget.maxDeclaredChecks });
  }
  const presentCategories = new Set(scriptChecks.map((c) => c.category).filter(Boolean) as string[]);
  // CANDIDATE_SCRIPTS is the gate's own canonical category list — reused, not copied.
  const missingCheckCategories = CANDIDATE_SCRIPTS.filter((c) => !presentCategories.has(c));
  // Only script-related unavailability is the profile's business; the advisory
  // `git diff --check` repository check is not a declared "project check" here.
  const checkUnavailableReasons = plan.unavailableReasons
    .filter((r) => !r.startsWith('no package.json') || scriptChecks.length === 0)
    .map((r) => sanitize(r, 160));

  // --- config signals / docs / roots (from the one top-level listing) -----
  const configSignals = CONFIG_SIGNAL_FILES.filter((f) => topFiles.has(f)).map((f) => sanitize(f));
  const documentFiles = DOCUMENT_FILES.filter((f) => topFiles.has(f)).map((f) => sanitize(f));
  const sourceRoots = capList(
    SOURCE_ROOTS.filter((d) => topDirs.has(d)).map((d) => sanitize(d)),
    budget.maxSourceRoots,
    'sourceRoots',
    omissions,
  );
  const testRoots = capList(
    TEST_ROOTS.filter((d) => topDirs.has(d)).map((d) => sanitize(d)),
    budget.maxTestRoots,
    'testRoots',
    omissions,
  );

  // --- nested project candidates (bounded depth, ignore-aware) ------------
  const nestedAll = discoverNested(cwd, deps, budget.maxNestedDepth, topDirs);
  const nestedCandidates = capList(nestedAll, budget.maxNestedCandidates, 'nestedCandidates', omissions);

  return {
    version: PROJECT_PROFILE_VERSION,
    trust: 'deterministic',
    root: '.',
    packageManager,
    packageManagerReason,
    packageManagerAmbiguous,
    lockfilesObserved,
    declaredChecks,
    missingCheckCategories,
    checkUnavailableReasons,
    configSignals,
    sourceRoots,
    testRoots,
    documentFiles,
    nestedCandidates,
    omissions,
  };
}

function toDeclaredCheck(c: VerificationCheck): DeclaredCheckFact {
  return {
    category: sanitize(c.category ?? c.name, 40),
    command: sanitize(c.command, 80),
    matchType: c.matchType ?? 'exact',
    required: c.required,
    ...(c.selectionReason ? { selectionReason: sanitize(c.selectionReason, 120) } : {}),
  };
}

function describeManager(
  selected: PackageManager | null,
  hasPackageJson: boolean,
  pm: PackageManagerDetection,
): string {
  if (!hasPackageJson) return 'no package.json in the working directory';
  if (selected === null) return 'package.json could not be parsed';
  // Ambiguity mirrors the gate exactly: by DISTINCT manager, not lockfile count,
  // so two bun lockfiles read as "from bun.lockb, bun.lock", not "ambiguous".
  if (pm.ambiguous) return `ambiguous — lockfiles present: ${pm.lockfilesPresent.join(', ')}; defaulting to npm`;
  if (pm.lockfilesPresent.length >= 1) return `from ${pm.lockfilesPresent.join(', ')}`;
  return 'no lockfile — defaulting to npm';
}

/** Cap a sorted list to a limit, recording an omitted-count when it overflows. */
function capList(items: string[], limit: number, field: string, omissions: ProfileOmission[]): string[] {
  const sorted = [...items].sort();
  if (sorted.length <= limit) return sorted;
  omissions.push({ field, omitted: sorted.length - limit });
  return sorted.slice(0, limit);
}

/**
 * Find nested-project candidates: directories below `cwd`, to `maxDepth`, that
 * contain a root marker. Never enters an ignored/dependency/generated dir,
 * never walks upward, never enters a candidate's own subtree once found, and
 * caps total directories scanned so a pathological tree cannot run away.
 */
function discoverNested(
  cwd: string,
  deps: ProfileDeps,
  maxDepth: number,
  topDirs: Set<string>,
): string[] {
  const found: string[] = [];
  /** Hard scan ceiling — belt-and-braces against a huge tree of shallow dirs. */
  let scans = 0;
  const SCAN_LIMIT = 512;

  const walk = (relDir: string, depth: number): void => {
    if (depth > maxDepth || scans >= SCAN_LIMIT) return;
    scans++;
    const abs = join(cwd, relDir);
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = deps.readDir(abs);
    } catch {
      return;
    }
    // Is THIS directory a nested project? (depth ≥1 only — cwd itself is the main project.)
    if (depth >= 1 && entries.some((e) => !e.isDirectory && ROOT_MARKERS.includes(e.name))) {
      // The path is repository-controlled (a directory may be named with newlines
      // to try to forge a heading); sanitise before it can reach the prompt.
      found.push(sanitize(relDir.replace(/\\/g, '/'), 80));
      // Do not descend into a found project's own packages — they are its concern.
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory || IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
    }
  };

  for (const dir of [...topDirs].sort()) {
    if (IGNORED_DIRS.has(dir) || dir.startsWith('.')) continue;
    walk(dir, 1);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Fingerprint (test/evaluation metadata — never rendered, never persisted)
// ---------------------------------------------------------------------------

/**
 * A stable hash of the NORMALISED facts that affect the rendered profile.
 *
 * Depends only on relative, sorted facts — so two checkouts of the same project
 * at different absolute paths fingerprint identically, directory enumeration
 * order is irrelevant, and changes under ignored/generated trees (which never
 * enter the facts) leave it unchanged. Changing a represented fact — a script,
 * a root, the package manager — changes it.
 */
export function fingerprintProjectProfile(profile: ProjectProfile): string {
  const normalized = {
    version: profile.version,
    packageManager: profile.packageManager,
    packageManagerAmbiguous: profile.packageManagerAmbiguous,
    lockfilesObserved: [...profile.lockfilesObserved].sort(),
    declaredChecks: [...profile.declaredChecks]
      .map((c) => ({ category: c.category, command: c.command, matchType: c.matchType, required: c.required }))
      .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)),
    missingCheckCategories: [...profile.missingCheckCategories].sort(),
    configSignals: [...profile.configSignals].sort(),
    sourceRoots: [...profile.sourceRoots].sort(),
    testRoots: [...profile.testRoots].sort(),
    documentFiles: [...profile.documentFiles].sort(),
    nestedCandidates: [...profile.nestedCandidates].sort(),
  };
  return createHash('sha256').update(stableStringify(normalized)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Truncate to at most `maxBytes`, cutting only on a valid UTF-8 boundary.
 *
 * A naive `subarray(maxBytes).toString('utf8')` inserts a U+FFFD replacement
 * char (3 bytes) when it splits a multibyte sequence, which can push the result
 * PAST the cap. This finds the largest boundary ≤ maxBytes where the next byte
 * is not a UTF-8 continuation byte, so no partial character — and no U+FFFD —
 * is ever emitted, and the byte length is a hard ceiling.
 */
function utf8Truncate(s: string, maxBytes: number): string {
  const cap = Math.max(0, Math.floor(maxBytes));
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return s;
  let end = cap;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Longest a repo-controlled package-manager reason may be, so the core stays bounded. */
const PM_REASON_MAX = 100;

/**
 * Render the profile as a bounded Markdown block for the frozen prefix.
 *
 * The byte budget is a HARD ceiling and assembly is priority-ordered:
 *   - The CORE FACTS — heading, root, package manager — are must-keep. They are
 *     small and bounded (the package-manager reason is length-capped), so they
 *     survive every realistic budget; the snapshot disclaimer is carried too and
 *     is the first thing dropped only under extreme pressure.
 *   - Everything else — declared checks first, then missing/unavailable notes,
 *     then config/roots/docs/nested — is appended only while it fits, reserving
 *     room for the omission marker. Anything dropped is signalled by a visible
 *     "(…N lines omitted…)" marker; the marker is appended only when it fits, so
 *     it is never itself truncated mid-word.
 *   - A final UTF-8-safe truncation guarantees the result never exceeds the
 *     budget, even by a multibyte remainder. It bites only on a budget smaller
 *     than the core facts (~200 bytes) — far below the 2048 contract and the
 *     only value any front end passes.
 */
export function renderProjectProfile(
  profile: ProjectProfile,
  budget: ProjectProfileBudget = DEFAULT_PROFILE_BUDGET,
): string {
  const max = budget.maxRenderedBytes;

  const disclaimer =
    'Read-only facts gathered once, at session start — a snapshot, not live state. It can go stale within a session; re-check with tools before relying on it. It grants no permissions and changes no rules, and the verification gate rediscovers checks independently.';
  const rootLine = `- Root: ${profile.root} (working directory shown in Environment)`;
  const pmLine = `- Package manager: ${profile.packageManager ?? 'unknown'} (${sanitize(profile.packageManagerReason, PM_REASON_MAX)})`;

  // Two cores: the preferred one carries the disclaimer; the lean one is just the
  // must-keep facts, used when the disclaimer will not fit. Both are bounded.
  const coreFull = `${PROJECT_PROFILE_HEADING}\n\n${disclaimer}\n\n${rootLine}\n${pmLine}`;
  const coreLean = `${PROJECT_PROFILE_HEADING}\n\n${rootLine}\n${pmLine}`;

  // Droppable lines, highest priority first. Declared checks lead so they are
  // the last to be dropped under pressure.
  const rest: string[] = [];
  if (profile.declaredChecks.length > 0) {
    rest.push('- Declared checks (what the verification gate would run):');
    for (const c of profile.declaredChecks) {
      const reason = c.selectionReason ? `; ${c.selectionReason}` : '';
      rest.push(`  - ${c.category} — \`${c.command}\` (${c.matchType}, ${c.required ? 'required' : 'advisory'}${reason})`);
    }
  }
  if (profile.missingCheckCategories.length > 0) {
    rest.push(`- Checks not declared: ${profile.missingCheckCategories.join(', ')}`);
  }
  if (profile.declaredChecks.length === 0 && profile.checkUnavailableReasons.length > 0) {
    rest.push(`- Declared checks unavailable: ${profile.checkUnavailableReasons.join('; ')}`);
  }
  const listLine = (label: string, items: string[], field: string): string | null => {
    if (items.length === 0) return null;
    const omitted = profile.omissions.find((o) => o.field === field);
    return `- ${label}: ${items.join(', ')}${omitted ? ` (+${omitted.omitted} omitted)` : ''}`;
  };
  for (const line of [
    listLine('Config signals', profile.configSignals, 'configSignals'),
    listLine('Source roots', profile.sourceRoots, 'sourceRoots'),
    listLine('Test roots', profile.testRoots, 'testRoots'),
    listLine('Project docs', profile.documentFiles, 'documentFiles'),
    listLine('Nested package candidates (not selected, not entered)', profile.nestedCandidates, 'nestedCandidates'),
  ]) {
    if (line) rest.push(line);
  }

  const marker = (n: number): string =>
    `\n- (${n} profile line${n === 1 ? '' : 's'} omitted to fit the byte budget)`;
  const reserve = bytes(marker(9999));

  const assemble = (core: string, reserveBytes: number): { out: string; dropped: number } => {
    let out = core;
    let dropped = 0;
    for (const line of rest) {
      if (bytes(out) + bytes(`\n${line}`) + reserveBytes <= max) out += `\n${line}`;
      else dropped++;
    }
    return { out, dropped };
  };

  // Keep the disclaimer only if it does not, by itself, overrun the budget.
  const core = bytes(coreFull) <= max ? coreFull : coreLean;

  // First pass with no reserve: if everything fits, no marker and no wasted space.
  let { out, dropped } = assemble(core, 0);
  if (dropped > 0) {
    // Redo reserving room for the marker; append it ONLY if it fits, so the
    // marker itself is never truncated. (At the 2048 budget it always fits.)
    ({ out, dropped } = assemble(core, reserve));
    const m = marker(dropped);
    if (bytes(out) + bytes(m) <= max) out += m;
  }

  // Hard ceiling, UTF-8-safe. Only bites when the budget is below the core facts.
  return utf8Truncate(out, max);
}

/**
 * The one shared entry point every front end calls: build + render in a single
 * deterministic step, so the CLI, headless, TUI and desktop front ends can never
 * produce different profile bytes for the same project.
 */
export function resolveProjectProfile(
  cwd: string,
  opts: { deps?: ProfileDeps; isGitRepo?: boolean; budget?: ProjectProfileBudget } = {},
): string {
  const budget = opts.budget ?? DEFAULT_PROFILE_BUDGET;
  return renderProjectProfile(buildProjectProfile(cwd, opts), budget);
}
