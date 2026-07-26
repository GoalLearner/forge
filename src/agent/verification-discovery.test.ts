/**
 * Qualified verification-script discovery.
 *
 * Motivated by a real repository. `awakened-app` declares `test:unit` and four
 * playwright variants and nothing else — no `typecheck`, no `build`, no plain
 * `test`. Under exact-name-only matching Forge selected nothing there and
 * reported `verification_unavailable` for every code-changing task, so the
 * verification loop contributed nothing on the repository it was most needed
 * for.
 *
 * These tests pin the wider matching AND the boundaries that keep it safe. The
 * dangerous direction here is not missing a script — that degrades honestly to
 * `unavailable` — it is running the wrong one. `npm run contest` or a
 * `playwright` suite fired automatically inside a repair loop would be a far
 * worse failure than no verification at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVerificationPlan, type VerificationPlan } from './verification.ts';

// ---------------------------------------------------------------------------
// Fake filesystem
// ---------------------------------------------------------------------------

function fsDeps(files: Record<string, string>) {
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

function planFrom(files: Record<string, string>): VerificationPlan {
  return buildVerificationPlan('/proj', { timeoutMs: 1000, isGitRepo: false, deps: fsDeps(files) });
}

/** node_modules + a lockfile, so discovery reaches script selection. */
const withScripts = (scripts: Record<string, string>): Record<string, string> => ({
  'package.json': pkg(scripts),
  'package-lock.json': '{}',
  node_modules: '',
});

const plan = (scripts: Record<string, string>): VerificationPlan => planFrom(withScripts(scripts));
const names = (p: VerificationPlan): string[] => p.checks.map((c) => c.name);
const selectedFor = (p: VerificationPlan, category: string): string | undefined =>
  p.checks.find((c) => c.category === category)?.name;

// ---------------------------------------------------------------------------
// Exact names keep priority
// ---------------------------------------------------------------------------

test('an exact test script is never displaced by a qualified one', () => {
  const p = plan({ test: 'node --test', 'test:unit': 'node --test u' });
  assert.equal(selectedFor(p, 'test'), 'test');
  assert.equal(p.checks.filter((c) => c.category === 'test').length, 1, 'one command per category');
  assert.equal(p.checks.find((c) => c.category === 'test')?.matchType, 'exact');
});

test('an exact typecheck script is never displaced by a qualified one', () => {
  const p = plan({ typecheck: 'tsc --noEmit', 'typecheck:app': 'tsc -p app' });
  assert.equal(selectedFor(p, 'typecheck'), 'typecheck');
});

test('an exact build script is never displaced by a qualified one', () => {
  const p = plan({ build: 'tsup', 'build:ci': 'tsup --ci' });
  assert.equal(selectedFor(p, 'build'), 'build');
});

test('exact selections are still marked as exact', () => {
  const p = plan({ typecheck: 'tsc --noEmit', test: 'node --test', build: 'tsup' });
  assert.deepEqual(names(p), ['typecheck', 'test', 'build'], 'category order is preserved');
  assert.ok(p.checks.every((c) => c.matchType === 'exact'));
  assert.ok(p.checks.every((c) => c.selectionReason === undefined));
});

// ---------------------------------------------------------------------------
// Safe qualified fallback
// ---------------------------------------------------------------------------

const FALLBACK_CASES: ReadonlyArray<readonly [string, string]> = [
  ['test:unit', 'test'],
  ['test:ci', 'test'],
  ['typecheck:app', 'typecheck'],
  ['server:typecheck', 'typecheck'],
  ['build:client', 'build'],
];

for (const [only, category] of FALLBACK_CASES) {
  test(`"${only}" alone is selected for the ${category} category`, () => {
    const p = plan({ [only]: 'node ok' });
    assert.equal(selectedFor(p, category), only);
    const c = p.checks.find((x) => x.category === category)!;
    assert.equal(c.matchType, 'qualified_fallback');
    assert.match(c.selectionReason ?? '', /no exact "/);
    assert.equal(c.required, true, 'a fallback still gates the run');
  });
}

test('ranking prefers the cheapest useful suite', () => {
  const p = plan({
    'test:zebra': 'node x',
    'test:all': 'node x',
    'test:ci': 'node x',
    'test:unit': 'node x',
  });
  assert.equal(selectedFor(p, 'test'), 'test:unit');
});

test('a prefix-form candidate outranks a suffix-form one', () => {
  const p = plan({ 'app:test': 'node x', 'test:zebra': 'node x' });
  assert.equal(selectedFor(p, 'test'), 'test:zebra');
});

test('unranked candidates sort lexicographically, not by manifest order', () => {
  const a = plan({ 'test:zebra': 'node x', 'test:alpha': 'node x' });
  const b = plan({ 'test:alpha': 'node x', 'test:zebra': 'node x' });
  assert.equal(selectedFor(a, 'test'), 'test:alpha');
  assert.equal(selectedFor(b, 'test'), 'test:alpha', 'key order in package.json must not matter');
});

test('an unsafe exact script does not block a safe qualified one', () => {
  // A project may well declare `test` as a watcher and `test:unit` as the real
  // suite; rejecting the watcher must not cost us the suite.
  const p = plan({ test: 'jest --watch', 'test:unit': 'node --test' });
  assert.equal(selectedFor(p, 'test'), 'test:unit');
});

test('one category can be exact while another falls back', () => {
  const p = plan({ typecheck: 'tsc --noEmit', 'test:unit': 'node --test' });
  assert.equal(p.checks.find((c) => c.category === 'typecheck')?.matchType, 'exact');
  assert.equal(p.checks.find((c) => c.category === 'test')?.matchType, 'qualified_fallback');
});

// ---------------------------------------------------------------------------
// Unsafe variants are never selected
// ---------------------------------------------------------------------------

const REJECTED = [
  'test:e2e',
  'test:e2e:headed',
  'test:e2e:ui',
  'test:e2e:report',
  'test:watch',
  'test:browser',
  'test:playwright',
  'test:cypress',
  'test:dev',
  'build:deploy',
  'build:release',
  'typecheck:watch',
];

for (const bad of REJECTED) {
  test(`"${bad}" is never selected`, () => {
    const p = plan({ [bad]: 'node something' });
    assert.deepEqual(names(p), [], 'no check may be built from an excluded script');
  });
}

test('a safely named candidate with a forbidden body is rejected', () => {
  const p = plan({ 'test:unit': 'npm publish && node --test' });
  assert.deepEqual(names(p), [], 'the body is filtered exactly like an exact script');
});

test('headless is eligible while headed is not', () => {
  assert.equal(selectedFor(plan({ 'test:headless': 'node --test' }), 'test'), 'test:headless');
  assert.deepEqual(names(plan({ 'test:headed': 'node --test' })), []);
});

test('a headless name still loses to a browser body', () => {
  assert.deepEqual(names(plan({ 'test:headless': 'playwright test' })), []);
});

// ---------------------------------------------------------------------------
// Substring false positives
// ---------------------------------------------------------------------------

test('words merely containing a category name never match', () => {
  const p = plan({
    contest: 'node x',
    latest: 'node x',
    'rebuild-cache': 'node x',
    'pretest-data': 'node x',
    'testing-server': 'node x',
    'building-docs': 'node x',
  });
  assert.deepEqual(names(p), [], 'segment matching, not substring matching');
});

// ---------------------------------------------------------------------------
// Nothing safe → unavailable, honestly
// ---------------------------------------------------------------------------

test('lint alone leaves verification unavailable', () => {
  const p = plan({ lint: 'eslint .' });
  assert.deepEqual(names(p), [], 'an optional check cannot establish verified status');
});

test('e2e variants alone leave verification unavailable', () => {
  const p = plan({ 'test:e2e': 'playwright test', 'test:e2e:ui': 'playwright test --ui' });
  assert.deepEqual(names(p), []);
  assert.match(p.unavailableReasons.join(' '), /no safe typecheck, test or build script/);
});

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

const MANAGERS: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm run test:unit'],
  ['pnpm-lock.yaml', 'pnpm run test:unit'],
  ['yarn.lock', 'yarn test:unit'],
  ['bun.lock', 'bun run test:unit'],
];

for (const [lock, expected] of MANAGERS) {
  test(`a qualified script uses the ${lock} package manager`, () => {
    const p = planFrom({
      'package.json': pkg({ 'test:unit': 'node x' }),
      [lock]: '',
      node_modules: '',
    });
    assert.equal(p.checks[0]?.command, expected);
  });
}

// ---------------------------------------------------------------------------
// Missing prerequisites stay honest
// ---------------------------------------------------------------------------

test('a qualified script without node_modules is unavailable, not selected', () => {
  const p = planFrom({ 'package.json': pkg({ 'test:unit': 'node x' }), 'package-lock.json': '' });
  assert.deepEqual(names(p), []);
  assert.match(p.unavailableReasons.join(' '), /node_modules is absent/);
});

test('an unparseable package.json still reports unavailable', () => {
  const p = planFrom({ 'package.json': '{ not json', node_modules: '' });
  assert.deepEqual(names(p), []);
  assert.match(p.unavailableReasons.join(' '), /could not be parsed/);
});

// ---------------------------------------------------------------------------
// The repository that motivated this
// ---------------------------------------------------------------------------

test('the awakened-app script set yields test:unit and nothing else', () => {
  const p = plan({
    'test:unit': 'node lib/economy.test.js',
    'test:e2e': 'playwright test',
    'test:e2e:headed': 'playwright test --headed',
    'test:e2e:ui': 'playwright test --ui',
    'test:e2e:report': 'playwright show-report',
  });

  assert.deepEqual(names(p), ['test:unit'], 'only the unit suite is safe to run automatically');
  assert.equal(p.checks[0]?.command, 'npm run test:unit');
  assert.equal(p.checks[0]?.matchType, 'qualified_fallback');
  assert.equal(p.checks[0]?.required, true);

  // The categories with no declared script stay genuinely absent, so a passing
  // run can never imply that typechecking or building happened.
  assert.equal(selectedFor(p, 'typecheck'), undefined);
  assert.equal(selectedFor(p, 'build'), undefined);
});
