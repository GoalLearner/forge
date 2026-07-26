/**
 * Old configuration files must keep working.
 *
 * Step 4A added three required limits to `AgentLimits`. If those ever became
 * required in the *schema* too, every existing `~/.forge/config.toml` would
 * fail to parse and Forge would refuse to start — a silent, total breakage for
 * anyone who upgraded. Backward compatibility was previously only demonstrated
 * by hand; this makes it part of the normal suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema } from './schema.ts';

const DEFAULTS = {
  toolTimeoutMs: 120_000,
  maxRuntimeMs: 900_000,
  maxExplicitShellTimeoutMs: 600_000,
};

test('an old config that predates Step 4A still parses and gets the defaults', () => {
  // Exactly what a pre-4A config.toml produces: the old limits and nothing else.
  const parsed = ConfigSchema.parse({
    permissions: { mode: 'auto-edit' },
    limits: { maxSteps: 20, maxRetries: 2, maxToolOutputBytes: 10_000 },
  });

  assert.equal(parsed.limits.maxSteps, 20, 'existing values are preserved');
  assert.equal(parsed.limits.maxRetries, 2);
  assert.equal(parsed.limits.maxToolOutputBytes, 10_000);

  assert.equal(parsed.limits.toolTimeoutMs, DEFAULTS.toolTimeoutMs);
  assert.equal(parsed.limits.maxRuntimeMs, DEFAULTS.maxRuntimeMs);
  assert.equal(parsed.limits.maxExplicitShellTimeoutMs, DEFAULTS.maxExplicitShellTimeoutMs);
});

test('a completely empty config gets every Step 4A default', () => {
  const parsed = ConfigSchema.parse({});
  assert.equal(parsed.limits.toolTimeoutMs, DEFAULTS.toolTimeoutMs);
  assert.equal(parsed.limits.maxRuntimeMs, DEFAULTS.maxRuntimeMs);
  assert.equal(parsed.limits.maxExplicitShellTimeoutMs, DEFAULTS.maxExplicitShellTimeoutMs);
});

test('a config with no limits section at all still parses', () => {
  const parsed = ConfigSchema.parse({ permissions: { mode: 'safe' } });
  assert.equal(parsed.limits.toolTimeoutMs, DEFAULTS.toolTimeoutMs);
  assert.equal(parsed.limits.maxRuntimeMs, DEFAULTS.maxRuntimeMs);
});

test('partial overrides are honoured without disturbing the others', () => {
  const parsed = ConfigSchema.parse({ limits: { toolTimeoutMs: 5_000 } });
  assert.equal(parsed.limits.toolTimeoutMs, 5_000);
  assert.equal(parsed.limits.maxRuntimeMs, DEFAULTS.maxRuntimeMs);
  assert.equal(parsed.limits.maxExplicitShellTimeoutMs, DEFAULTS.maxExplicitShellTimeoutMs);
});

test('nonsense limit values are rejected rather than silently coerced', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '120000']) {
    for (const field of ['toolTimeoutMs', 'maxRuntimeMs', 'maxExplicitShellTimeoutMs']) {
      const result = ConfigSchema.safeParse({ limits: { [field]: bad } });
      assert.equal(result.success, false, `${field}=${String(bad)} must be rejected`);
    }
  }
});
