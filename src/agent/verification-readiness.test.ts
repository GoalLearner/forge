/**
 * Daily-use finding 001 — zero-dependency declared checks.
 *
 * v1 let a dependency-free `test: node --test` run without node_modules, which
 * was right. Independent verification then showed two ways that exception could
 * still turn an ENVIRONMENT problem into a persisted project-code FAILURE:
 *
 *   - `npm test` also runs `pretest`/`posttest`, so a `pretest: vitest` hook
 *     executed and failed even though the inspected body was pure node;
 *   - the emitted command may be `pnpm run test` on a machine with no pnpm.
 *
 * These tests pin the corrected contract: without node_modules the exception
 * applies only to npm, only to a package whose dependency metadata is a shape
 * we understand and empty, and only when the whole effective lifecycle chain
 * (pre<S>, S, post<S>) is a direct node invocation. With node_modules present,
 * nothing changes.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVerificationPlan,
  classifyDeclaredCheckReadiness,
  classifyDependencyMetadata,
  isEligibleDirectNodeCommand,
  type DependencyMetadataState,
} from './verification.ts';
import { buildProjectProfile, type ProfileDeps } from './project-profile.ts';

// ---------------------------------------------------------------------------
// Fixtures. ProfileDeps is a structural superset of the plan builder's deps, so
// one fixture drives both the gate and the profile (parity is checked below).
// ---------------------------------------------------------------------------

const fixture = (files: Record<string, string>, dirs: string[] = []): ProfileDeps => {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const all = new Set<string>(['/repo']);
  for (const f of Object.keys(files)) {
    all.add('/repo/' + f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) all.add('/repo/' + parts.slice(0, i).join('/'));
  }
  for (const d of dirs) all.add('/repo/' + d);
  return {
    exists: (p) => all.has(norm(p)),
    readFile: (p) => {
      const body = files[norm(p).replace('/repo/', '')];
      if (body === undefined) throw new Error('no file ' + p);
      return body;
    },
    readDir: () => [],
  };
};

const manifest = (o: object): string => JSON.stringify(o, null, 2);
const npmRepo = (o: object, dirs: string[] = []): ProfileDeps =>
  fixture({ 'package.json': manifest(o), 'package-lock.json': '{}' }, dirs);
const plan = (deps: ProfileDeps) =>
  buildVerificationPlan('/repo', { timeoutMs: 1000, isGitRepo: false, deps });
const scriptChecks = (deps: ProfileDeps) =>
  plan(deps).checks.filter((c) => c.source === 'package_script');
const reasons = (deps: ProfileDeps): string => plan(deps).unavailableReasons.join(' | ');

const readiness = (
  scriptName: string,
  scripts: Record<string, string>,
  over: Partial<Parameters<typeof classifyDeclaredCheckReadiness>[0]> = {},
) =>
  classifyDeclaredCheckReadiness({
    scriptName,
    scripts,
    hasNodeModules: false,
    dependencyState: 'none' as DependencyMetadataState,
    packageManager: 'npm',
    ...over,
  });

// ---------------------------------------------------------------------------
// The direct-node command primitive
// ---------------------------------------------------------------------------

describe('isEligibleDirectNodeCommand', () => {
  test('accepts bare direct node invocations', () => {
    for (const body of ['node --test', 'node --check src/index.js', 'node checks/check.mjs', '  node --test  ']) {
      assert.equal(isEligibleDirectNodeCommand(body), true, body);
    }
  });

  test('rejects package binaries, npx and other runtimes', () => {
    for (const body of ['vitest', 'jest', 'tsc --noEmit', 'eslint .', 'vite build', 'npx vitest', 'npx node --test', 'nodejs --test', 'node.exe --test', '"node" --test', 'NODE_ENV=test node --test']) {
      assert.equal(isEligibleDirectNodeCommand(body), false, body);
    }
  });

  test('rejects every shell composition, redirection and substitution form', () => {
    for (const body of ['node a.js && node b.js', 'node a.js || exit 0', 'node a.js; node b.js', 'node a.js | tee log', 'node a.js > out.txt', 'node a.js < in.txt', 'node $(pick).js', 'node `pick`.js', 'node --test\nvitest', 'node --test\r\nvitest']) {
      assert.equal(isEligibleDirectNodeCommand(body), false, JSON.stringify(body));
    }
  });

  test('rejects an empty or whitespace body', () => {
    assert.equal(isEligibleDirectNodeCommand(''), false);
    assert.equal(isEligibleDirectNodeCommand('   '), false);
  });
});

// ---------------------------------------------------------------------------
// Dependency metadata — conservative by construction
// ---------------------------------------------------------------------------

describe('classifyDependencyMetadata', () => {
  test('missing fields and empty plain objects declare nothing', () => {
    assert.equal(classifyDependencyMetadata({}), 'none');
    assert.equal(
      classifyDependencyMetadata({ dependencies: {}, devDependencies: {}, optionalDependencies: {}, peerDependencies: {} }),
      'none',
    );
  });

  test('any populated field of the four declares dependencies', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(classifyDependencyMetadata({ [field]: { a: '1' } }), 'declared', field);
    }
  });

  test('null, arrays and primitives are unsupported shapes, never dependency-free', () => {
    for (const value of [null, [], ['a'], 'str', 42, 0, true, false]) {
      assert.equal(
        classifyDependencyMetadata({ dependencies: value }),
        'unsupported_shape',
        JSON.stringify(value),
      );
    }
  });

  test('null does not throw (the v1 crash that was misreported as a parse failure)', () => {
    assert.doesNotThrow(() => classifyDependencyMetadata({ dependencies: null }));
  });
});

// ---------------------------------------------------------------------------
// The readiness classifier
// ---------------------------------------------------------------------------

describe('classifyDeclaredCheckReadiness', () => {
  test('node_modules present is runnable regardless of manager, hooks or metadata', () => {
    const r = readiness('test', { pretest: 'vitest', test: 'vitest' }, {
      hasNodeModules: true,
      packageManager: 'pnpm',
      dependencyState: 'declared',
      managerAmbiguous: true,
    });
    assert.equal(r.readiness, 'runnable');
  });

  test('a dependency-free direct node script on npm is runnable', () => {
    assert.equal(readiness('test', { test: 'node --test' }).readiness, 'runnable');
  });

  test('declared dependencies block, with the install reason', () => {
    const r = readiness('test', { test: 'node --test' }, { dependencyState: 'declared' });
    assert.equal(r.readiness, 'unavailable_missing_dependencies');
    assert.match(r.reason, /never installs/);
  });

  test('unsupported dependency metadata blocks', () => {
    const r = readiness('test', { test: 'node --test' }, { dependencyState: 'unsupported_shape' });
    assert.equal(r.readiness, 'unavailable_unsupported_dependency_metadata');
    assert.match(r.reason, /unsupported shape/);
  });

  test('pnpm, yarn and bun are outside the exception', () => {
    for (const pm of ['pnpm', 'yarn', 'bun'] as const) {
      const r = readiness('test', { test: 'node --test' }, { packageManager: pm });
      assert.equal(r.readiness, 'unavailable_unsupported_manager', pm);
      assert.match(r.reason, /only for npm/);
    }
  });

  test('an ambiguous manager is outside the exception even when it resolves to npm', () => {
    const r = readiness('test', { test: 'node --test' }, { managerAmbiguous: true });
    assert.equal(r.readiness, 'unavailable_unsupported_manager');
  });

  test('a non-direct selected body blocks', () => {
    assert.equal(readiness('test', { test: 'vitest' }).readiness, 'unavailable_unsupported_command');
  });

  test('a missing or blank selected body is unknown, never runnable', () => {
    assert.equal(readiness('test', {}).readiness, 'unknown');
    assert.equal(readiness('test', { test: '  ' }).readiness, 'unknown');
  });

  test('an unsupported pre hook blocks and names the hook', () => {
    const r = readiness('test', { pretest: 'vitest', test: 'node --test' });
    assert.equal(r.readiness, 'unavailable_unsupported_lifecycle');
    assert.match(r.reason, /"pretest"/);
    assert.ok(!r.reason.includes('vitest'), 'the reason must not carry the raw script body');
  });

  test('an unsupported post hook blocks and names the hook', () => {
    const r = readiness('test', { test: 'node --test', posttest: 'jest' });
    assert.equal(r.readiness, 'unavailable_unsupported_lifecycle');
    assert.match(r.reason, /"posttest"/);
  });

  test('a fully direct-node chain is runnable', () => {
    const r = readiness('test', { pretest: 'node checks/pre.mjs', test: 'node --test', posttest: 'node checks/post.mjs' });
    assert.equal(r.readiness, 'runnable');
  });

  test('qualified script names carry their own hooks', () => {
    assert.equal(
      readiness('test:unit', { 'pretest:unit': 'vitest', 'test:unit': 'node --test' }).readiness,
      'unavailable_unsupported_lifecycle',
    );
    assert.equal(
      readiness('test:unit', { 'test:unit': 'node --test', 'posttest:unit': 'jest' }).readiness,
      'unavailable_unsupported_lifecycle',
    );
    assert.equal(
      readiness('test:unit', { 'pretest:unit': 'node a.mjs', 'test:unit': 'node --test', 'posttest:unit': 'node b.mjs' }).readiness,
      'runnable',
    );
  });

  test('hooks are inspected one level only — npm does not run pre<pre<S>>', () => {
    const r = readiness('test', { prepretest: 'vitest', pretest: 'node a.mjs', test: 'node --test' });
    assert.equal(r.readiness, 'runnable');
  });

  test('a blank or composed hook body blocks', () => {
    assert.equal(readiness('test', { pretest: '   ', test: 'node --test' }).readiness, 'unavailable_unsupported_lifecycle');
    assert.equal(readiness('test', { pretest: 'node a.mjs && vitest', test: 'node --test' }).readiness, 'unavailable_unsupported_lifecycle');
  });
});

// ---------------------------------------------------------------------------
// Plan level — eligible npm chains
// ---------------------------------------------------------------------------

describe('eligible npm chains without node_modules', () => {
  test('1. plain node --test with no hooks', () => {
    const deps = npmRepo({ name: 'z', type: 'module', scripts: { test: 'node --test' } });
    assert.deepEqual(scriptChecks(deps).map((c) => c.category + '|' + c.command), ['test|npm test']);
  });

  test('2. direct-node pretest, test and posttest', () => {
    const deps = npmRepo({ name: 'z', scripts: { pretest: 'node checks/pre.mjs', test: 'node --test', posttest: 'node checks/post.mjs' } });
    assert.equal(scriptChecks(deps).length, 1);
  });

  test('3. direct-node qualified chain', () => {
    const deps = npmRepo({ name: 'z', scripts: { 'pretest:unit': 'node p.mjs', 'test:unit': 'node --test', 'posttest:unit': 'node q.mjs' } });
    assert.deepEqual(scriptChecks(deps).map((c) => c.category + '|' + c.command), ['test|npm run test:unit']);
  });

  test('4. direct-node build chain', () => {
    const deps = npmRepo({ name: 'z', scripts: { prebuild: 'node pre.mjs', build: 'node build.mjs' } });
    assert.deepEqual(scriptChecks(deps).map((c) => c.category), ['build']);
  });

  test('5. direct-node typecheck chain', () => {
    const deps = npmRepo({ name: 'z', scripts: { typecheck: 'node --check src/index.js', posttypecheck: 'node after.mjs' } });
    assert.deepEqual(scriptChecks(deps).map((c) => c.category), ['typecheck']);
  });

  test('6. CRLF manifest with an eligible chain', () => {
    const body = manifest({ name: 'z', scripts: { pretest: 'node pre.mjs', test: 'node --test' } }).replace(/\n/g, '\r\n');
    const deps = fixture({ 'package.json': body, 'package-lock.json': '{}' });
    assert.equal(scriptChecks(deps).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Plan level — lifecycle must remain unavailable
// ---------------------------------------------------------------------------

describe('unsupported lifecycle chains stay unavailable', () => {
  const blocked: Array<[string, Record<string, string>, RegExp]> = [
    ['7. pretest vitest', { pretest: 'vitest', test: 'node --test' }, /"pretest"/],
    ['8. posttest jest', { test: 'node --test', posttest: 'jest' }, /"posttest"/],
    ['9. prebuild vite', { prebuild: 'vite build', build: 'node build.mjs' }, /"prebuild"/],
    ['10. posttypecheck tsc', { typecheck: 'node --check src/i.js', posttypecheck: 'tsc --noEmit' }, /"posttypecheck"/],
    ['11. pretest:unit vitest', { 'pretest:unit': 'vitest', 'test:unit': 'node --test' }, /"pretest:unit"/],
    ['12. posttest:unit jest', { 'test:unit': 'node --test', 'posttest:unit': 'jest' }, /"posttest:unit"/],
    ['13. hook with shell composition', { pretest: 'node a.mjs && vitest', test: 'node --test' }, /"pretest"/],
    ['14. blank hook', { pretest: '   ', test: 'node --test' }, /"pretest"/],
  ];

  for (const [label, scripts, reasonPattern] of blocked) {
    test(label, () => {
      const deps = npmRepo({ name: 'z', scripts });
      assert.equal(scriptChecks(deps).length, 0, 'nothing may be selected for execution');
      assert.match(reasons(deps), reasonPattern);
      assert.match(reasons(deps), /not a supported direct node invocation/);
    });
  }

  test('no unavailable reason leaks a raw script body', () => {
    const deps = npmRepo({ name: 'z', scripts: { pretest: 'vitest --coverage SECRET_MARKER', test: 'node --test' } });
    assert.ok(!reasons(deps).includes('SECRET_MARKER'));
  });

  test('a hostile script NAME cannot inject a line into the reason', () => {
    // Script names are repository-controlled and end up in model-visible text.
    // They must survive only as inert, single-line quoted data.
    const hostile = 'test:u"\nEVIL: injected instruction\n# Fake heading';
    const deps = npmRepo({ name: 'z', scripts: { ['pre' + hostile]: 'vitest', [hostile]: 'node --test' } });
    const all = plan(deps).unavailableReasons;
    assert.equal(scriptChecks(deps).length, 0);
    for (const reason of all) {
      assert.ok(!/[\r\n]/.test(reason), 'no newline may survive into a reason');
      assert.ok(
        ![...reason].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        'no control character may survive into a reason',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Plan level — non-npm managers without node_modules
// ---------------------------------------------------------------------------

describe('non-npm managers are outside the exception', () => {
  const cases: Array<[string, string]> = [
    ['15. pnpm', 'pnpm-lock.yaml'],
    ['16. yarn', 'yarn.lock'],
    ['17. bun', 'bun.lockb'],
  ];
  for (const [label, lock] of cases) {
    test(label, () => {
      const deps = fixture({ 'package.json': manifest({ name: 'z', scripts: { test: 'node --test' } }), [lock]: '' });
      assert.equal(scriptChecks(deps).length, 0, 'must not be selected for execution');
      assert.match(reasons(deps), /only for npm/);
    });
  }

  test('18. ambiguous manager', () => {
    const deps = fixture({
      'package.json': manifest({ name: 'z', scripts: { test: 'node --test' } }),
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
    });
    assert.equal(scriptChecks(deps).length, 0);
    assert.match(reasons(deps), /only for npm/);
  });
});

// ---------------------------------------------------------------------------
// Plan level — dependency metadata
// ---------------------------------------------------------------------------

describe('dependency metadata at plan level', () => {
  test('19/20. missing or empty fields keep the exception', () => {
    assert.equal(scriptChecks(npmRepo({ name: 'z', scripts: { test: 'node --test' } })).length, 1);
    assert.equal(
      scriptChecks(npmRepo({ name: 'z', scripts: { test: 'node --test' }, dependencies: {}, devDependencies: {}, optionalDependencies: {}, peerDependencies: {} })).length,
      1,
    );
  });

  test('21-24. any populated dependency field blocks with the install reason', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = npmRepo({ name: 'z', scripts: { test: 'node --test' }, [field]: { a: '1' } });
      assert.equal(scriptChecks(deps).length, 0, field);
      assert.match(reasons(deps), /never installs/);
    }
  });

  test('25-29. null, array, string, number and boolean shapes block', () => {
    for (const value of [null, ['a'], 'str', 42, true]) {
      const deps = npmRepo({ name: 'z', scripts: { test: 'node --test' }, dependencies: value });
      assert.equal(scriptChecks(deps).length, 0, JSON.stringify(value));
      assert.match(reasons(deps), /unsupported shape/, JSON.stringify(value));
    }
  });

  test('30. malformed package.json remains a parse failure', () => {
    const deps = fixture({ 'package.json': '{ not json', 'package-lock.json': '{}' });
    assert.equal(scriptChecks(deps).length, 0);
    assert.match(reasons(deps), /could not be parsed/);
  });
});

// ---------------------------------------------------------------------------
// Plan level — existing behavior with node_modules present
// ---------------------------------------------------------------------------

describe('node_modules present keeps pre-correction semantics', () => {
  const nm = ['node_modules'];

  test('31-34. every manager still runs its own command form', () => {
    const cases: Array<[string, string, string]> = [
      ['package-lock.json', 'npm', 'npm test'],
      ['pnpm-lock.yaml', 'pnpm', 'pnpm run test'],
      ['yarn.lock', 'yarn', 'yarn test'],
      ['bun.lockb', 'bun', 'bun run test'],
    ];
    for (const [lock, manager, command] of cases) {
      const deps = fixture({ 'package.json': manifest({ name: 'z', scripts: { test: 'vitest' }, devDependencies: { vitest: '^1' } }), [lock]: '' }, nm);
      const p = plan(deps);
      assert.equal(p.packageManager, manager, lock);
      assert.deepEqual(p.checks.filter((c) => c.source === 'package_script').map((c) => c.command), [command], lock);
    }
  });

  test('35. exact scripts across all three categories', () => {
    const deps = npmRepo({ name: 'z', scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'vite build' }, devDependencies: { v: '1' } }, nm);
    assert.deepEqual(scriptChecks(deps).map((c) => c.category), ['typecheck', 'test', 'build']);
  });

  test('36. qualified fallback still selected', () => {
    const deps = npmRepo({ name: 'z', scripts: { 'test:unit': 'vitest run' }, devDependencies: { v: '1' } }, nm);
    assert.deepEqual(scriptChecks(deps).map((c) => c.command), ['npm run test:unit']);
  });

  test('37. unsafe browser/e2e scripts stay excluded', () => {
    const deps = npmRepo({ name: 'z', scripts: { test: 'vitest --watch' }, devDependencies: { v: '1' } }, nm);
    assert.equal(scriptChecks(deps).length, 0);
  });

  test('38. missing categories reported unchanged', () => {
    const deps = npmRepo({ name: 'z', scripts: { typecheck: 'tsc' }, devDependencies: { t: '1' } }, nm);
    assert.deepEqual(scriptChecks(deps).map((c) => c.category), ['typecheck']);
  });

  test('an unsupported hook does NOT block when node_modules exists', () => {
    const deps = npmRepo({ name: 'z', scripts: { pretest: 'vitest', test: 'node --test' } }, nm);
    assert.equal(scriptChecks(deps).length, 1, 'installed projects keep their prior semantics');
  });
});

// ---------------------------------------------------------------------------
// 39. Canonical profile / gate parity
// ---------------------------------------------------------------------------

describe('profile and gate stay canonical', () => {
  const parityCases: Array<[string, ProfileDeps]> = [
    ['zero-dep npm chain', npmRepo({ name: 'z', scripts: { pretest: 'node p.mjs', test: 'node --test' } })],
    ['unsupported hook', npmRepo({ name: 'z', scripts: { pretest: 'vitest', test: 'node --test' } })],
    ['pnpm without node_modules', fixture({ 'package.json': manifest({ name: 'z', scripts: { test: 'node --test' } }), 'pnpm-lock.yaml': '' })],
    ['unsupported metadata', npmRepo({ name: 'z', scripts: { test: 'node --test' }, dependencies: null })],
    ['node_modules present', npmRepo({ name: 'z', scripts: { test: 'vitest', typecheck: 'tsc' }, devDependencies: { v: '1' } }, ['node_modules'])],
  ];

  for (const [label, deps] of parityCases) {
    test(`39. ${label}: profile mirrors the plan exactly`, () => {
      const gate = scriptChecks(deps).map((c) => `${c.category}|${c.command}|${c.required}`);
      const profile = buildProjectProfile('/repo', { deps, isGitRepo: false });
      assert.deepEqual(profile.declaredChecks.map((c) => `${c.category}|${c.command}|${c.required}`), gate);
      assert.deepEqual(profile.checkUnavailableReasons, plan(deps).unavailableReasons);
    });
  }
});
