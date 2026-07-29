/**
 * Daily-use finding 001 — zero-dependency declared checks.
 *
 * A project declaring `test: node --test` with NO dependencies of any kind was
 * marked unavailable purely because node_modules did not exist, even though the
 * command runs fine without installing anything. These tests pin the narrow
 * corrected rule: direct-node scripts in dependency-free packages are runnable
 * without node_modules; package binaries, npx, composed commands, and any
 * package that declares dependencies keep the honest unavailable result.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerificationPlan, classifyDeclaredCheckReadiness } from './verification.ts';
import { buildProjectProfile, type ProfileDeps } from './project-profile.ts';

// ---------------------------------------------------------------------------
// In-memory fixture harness. ProfileDeps is a structural superset of the plan
// builder's deps, so one fixture serves both the gate and the profile.
// ---------------------------------------------------------------------------

const fixture = (files: Record<string, string>, dirs: string[] = []): ProfileDeps => {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const all = new Set<string>();
  for (const f of Object.keys(files)) {
    all.add('/repo/' + f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) all.add('/repo/' + parts.slice(0, i).join('/'));
  }
  for (const d of dirs) all.add('/repo/' + d);
  return {
    exists: (p) => all.has(norm(p)) || norm(p) === '/repo',
    readFile: (p) => {
      const rel = norm(p).replace('/repo/', '');
      const body = files[rel];
      if (body === undefined) throw new Error('no file ' + p);
      return body;
    },
    readDir: () => [],
  };
};

const pkg = (o: object): string => JSON.stringify(o, null, 2);
const plan = (deps: ProfileDeps) => buildVerificationPlan('/repo', { timeoutMs: 1000, isGitRepo: false, deps });
const scriptChecks = (deps: ProfileDeps) => plan(deps).checks.filter((c) => c.source === 'package_script');

// ---------------------------------------------------------------------------
// The classifier itself
// ---------------------------------------------------------------------------

describe('classifyDeclaredCheckReadiness', () => {
  const zero = { hasNodeModules: false, declaresDependencies: false };

  test('direct node invocations are runnable without node_modules in a dependency-free package', () => {
    for (const body of ['node --test', 'node --check src/index.js', 'node checks/check.mjs']) {
      assert.equal(classifyDeclaredCheckReadiness({ scriptBody: body, ...zero }), 'runnable', body);
    }
  });

  test('package binaries stay unavailable without node_modules', () => {
    for (const body of ['vitest', 'jest', 'tsc --noEmit', 'eslint .', 'vite build']) {
      assert.equal(
        classifyDeclaredCheckReadiness({ scriptBody: body, ...zero }),
        'unavailable_unsupported_command',
        body,
      );
    }
  });

  test('npx does not count as a direct node invocation', () => {
    assert.equal(classifyDeclaredCheckReadiness({ scriptBody: 'npx vitest', ...zero }), 'unavailable_unsupported_command');
  });

  test('shell composition and substitution are rejected even when node-prefixed', () => {
    for (const body of ['node a.js && node b.js', 'node a.js; node b.js', 'node a.js | tee log', 'node $(pick).js', 'node a.js > out.txt']) {
      assert.equal(
        classifyDeclaredCheckReadiness({ scriptBody: body, ...zero }),
        'unavailable_unsupported_command',
        body,
      );
    }
  });

  test('declared dependencies keep every script unavailable without node_modules', () => {
    assert.equal(
      classifyDeclaredCheckReadiness({ scriptBody: 'node --test', hasNodeModules: false, declaresDependencies: true }),
      'unavailable_missing_dependencies',
    );
  });

  test('node_modules present keeps existing semantics — everything selected is runnable', () => {
    assert.equal(classifyDeclaredCheckReadiness({ scriptBody: 'vitest', hasNodeModules: true, declaresDependencies: true }), 'runnable');
    assert.equal(classifyDeclaredCheckReadiness({ scriptBody: 'node --test', hasNodeModules: true, declaresDependencies: false }), 'runnable');
  });

  test('an empty script body is unknown, never runnable', () => {
    assert.equal(classifyDeclaredCheckReadiness({ scriptBody: '   ', ...zero }), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Plan-level behavior
// ---------------------------------------------------------------------------

describe('zero-dependency plans', () => {
  test('node --test is selected and runnable without node_modules', () => {
    const deps = fixture({
      'package.json': pkg({ name: 'z', type: 'module', scripts: { test: 'node --test' } }),
      'package-lock.json': '{}',
    });
    const p = plan(deps);
    const tests = p.checks.filter((c) => c.category === 'test');
    assert.equal(tests.length, 1);
    assert.equal(tests[0]!.command, 'npm test');
    assert.ok(!p.unavailableReasons.some((r) => r.includes('node_modules')), 'no node_modules complaint');
  });

  test('direct node file checks are runnable without node_modules', () => {
    const deps = fixture({
      'package.json': pkg({ name: 'z', scripts: { test: 'node checks/check.mjs', typecheck: 'node --check src/index.js' } }),
    });
    assert.deepEqual(scriptChecks(deps).map((c) => c.category).sort(), ['test', 'typecheck']);
  });

  test('CRLF package.json with a direct node check still parses and is runnable', () => {
    const body = pkg({ name: 'z', scripts: { test: 'node --test' } }).replace(/\n/g, '\r\n');
    const deps = fixture({ 'package.json': body });
    assert.equal(scriptChecks(deps).length, 1);
  });

  test('vitest/jest/npx stay unavailable without node_modules, with an accurate reason', () => {
    for (const body of ['vitest', 'jest', 'npx vitest', 'tsc --noEmit']) {
      const deps = fixture({ 'package.json': pkg({ name: 'z', scripts: { test: body } }) });
      assert.equal(scriptChecks(deps).length, 0, body);
      assert.ok(
        plan(deps).unavailableReasons.some((r) => r.includes('not a direct node invocation')),
        body,
      );
    }
  });

  test('a package declaring dependencies keeps the original unavailable reason', () => {
    const deps = fixture({
      'package.json': pkg({
        name: 'z',
        scripts: { test: 'node --test' },
        devDependencies: { typescript: '^5' },
      }),
    });
    assert.equal(scriptChecks(deps).length, 0);
    assert.ok(plan(deps).unavailableReasons.some((r) => r.includes('forge never installs')));
  });

  test('a qualified fallback invoking a package binary stays unavailable without node_modules', () => {
    const deps = fixture({
      'package.json': pkg({ name: 'z', scripts: { 'test:unit': 'vitest run' } }),
    });
    assert.equal(scriptChecks(deps).length, 0);
  });

  test('node_modules present: package-binary scripts are selected exactly as before', () => {
    const deps = fixture(
      { 'package.json': pkg({ name: 'z', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }) },
      ['node_modules'],
    );
    assert.equal(scriptChecks(deps).length, 1);
  });

  test('unsafe scripts remain excluded regardless of readiness', () => {
    const deps = fixture({ 'package.json': pkg({ name: 'z', scripts: { test: 'node --test --watch' } }) });
    assert.equal(scriptChecks(deps).length, 0);
  });

  test('malformed package.json still reports the parse failure', () => {
    const deps = fixture({ 'package.json': '{ not json' });
    assert.equal(scriptChecks(deps).length, 0);
    assert.ok(plan(deps).unavailableReasons.some((r) => r.includes('could not be parsed')));
  });
});

// ---------------------------------------------------------------------------
// Profile / gate parity — the profile must show the same runnable check.
// ---------------------------------------------------------------------------

describe('profile parity for zero-dependency checks', () => {
  test('the profile lists the zero-dependency node --test check as declared, not unavailable', () => {
    const deps = fixture({
      'package.json': pkg({ name: 'z', type: 'module', scripts: { test: 'node --test' } }),
      'package-lock.json': '{}',
    });
    const profile = buildProjectProfile('/repo', { deps, isGitRepo: false });
    assert.deepEqual(
      profile.declaredChecks.map((c) => c.category + '|' + c.command),
      scriptChecks(deps).map((c) => c.category + '|' + c.command),
      'profile checks must equal the gate plan checks',
    );
    assert.equal(profile.declaredChecks.length, 1);
    assert.ok(!profile.checkUnavailableReasons.some((r) => r.includes('node_modules')));
  });
});
