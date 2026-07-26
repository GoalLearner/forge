/**
 * Tests for `forge --cost`.
 *
 * The report's job is to make one number impossible to miss: the cache hit
 * rate. A cost report that renders a plausible dollar figure while quietly
 * hiding a collapsed hit rate is worse than none, because it reassures you at
 * exactly the moment you should be alarmed.
 *
 * Formatting is tested against hand-built CostReport values rather than through
 * the database. The renderers are pure functions of their input, so going
 * through SQLite would only add shared state between tests — and every test in
 * a file shares one database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), 'forge-report-'));

import { SessionStore } from './store.ts';
import { buildCostReport, formatCostJson, formatCostText, type CostReport } from './report.ts';
import { EMPTY_TOTALS, type UsageTotals } from './cost.ts';
import type { ModelEntry } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Totals with a given cache split, priced so the saving is non-zero. */
function totals(cached: number, uncached: number, requests = 1): UsageTotals {
  const perMillion = (t: number, price: number): number => (t / 1_000_000) * price;
  return {
    requests,
    inputTokens: uncached,
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: 500,
    cost: perMillion(uncached, 0.435) + perMillion(cached, 0.003625) + perMillion(500, 0.87),
    uncachedCost: perMillion(uncached + cached, 0.435) + perMillion(500, 0.87),
  };
}

function report(overrides: Partial<CostReport> = {}): CostReport {
  const base = totals(90_000, 10_000);
  return {
    cwd: 'C:/projects/alpha',
    today: base,
    directory: base,
    allTime: base,
    byModel: [{ modelKey: 'deepseek/deepseek-v4-pro', totals: base }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('reports nothing gracefully before any usage exists', () => {
  const empty = report({
    today: { ...EMPTY_TOTALS },
    directory: { ...EMPTY_TOTALS },
    allTime: { ...EMPTY_TOTALS },
    byModel: [],
  });
  assert.match(formatCostText(empty), /No usage recorded yet/);
});

test('leads with the cache hit rate, above the dollar figure', () => {
  const text = formatCostText(report());
  const firstDataLine = text.split('\n').filter((l) => l.trim())[1] ?? '';

  assert.match(firstDataLine, /Cache hit rate/, 'the hit rate must come first');
  assert.match(text, /90\.0%/);
});

test('quantifies what caching saved', () => {
  const text = formatCostText(report());
  assert.match(text, /Caching saved/);
  assert.match(text, /off\)/, 'a percentage makes the saving legible at a glance');
});

test('calls out a collapsed hit rate rather than letting it pass', () => {
  // Six requests, nothing cached — the exact situation this report exists for.
  const bad = totals(0, 10_000, 6);
  const text = formatCostText(report({ today: bad, directory: bad, allTime: bad, byModel: [] }));

  assert.match(text, /Low hit rate/i);
  assert.match(text, /prefix is changing/i, 'a warning without a cause is not actionable');
});

test('stays quiet about a low hit rate on a run too short to judge', () => {
  // The first request has nothing to hit, so 0% there is correct, not a fault.
  const young = totals(0, 10_000, 1);
  const text = formatCostText(report({ today: young, directory: young, allTime: young, byModel: [] }));
  assert.doesNotMatch(text, /Low hit rate/i);
});

test('breaks down by model only when more than one was used', () => {
  const single = formatCostText(report());
  assert.doesNotMatch(single, /By model/);

  const base = totals(90_000, 10_000);
  const multi = formatCostText(
    report({
      byModel: [
        { modelKey: 'deepseek/deepseek-v4-pro', totals: base },
        { modelKey: 'anthropic/claude-opus-5', totals: base },
      ],
    }),
  );
  assert.match(multi, /By model/);
  assert.match(multi, /anthropic\/claude-opus-5/, 'an escalation should be visible as its own line');
});

test('always states that the figures are estimates', () => {
  assert.match(formatCostText(report()), /Estimated from prices in models\.json/);
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

test('emits valid JSON for scripting', () => {
  const parsed = JSON.parse(formatCostJson(report())) as {
    cwd: string;
    allTime: { requests: number; cacheHitRate: number; saved: number };
    byModel: Array<{ model: string }>;
  };

  assert.equal(parsed.cwd, 'C:/projects/alpha');
  assert.equal(parsed.allTime.requests, 1);
  assert.equal(parsed.allTime.cacheHitRate, 0.9);
  assert.ok(parsed.allTime.saved > 0);
  assert.equal(parsed.byModel[0]?.model, 'deepseek/deepseek-v4-pro');
});

test('the JSON hit rate agrees with the text hit rate', () => {
  // Two renderers, one truth. Drift would make the scripted number quietly
  // disagree with the one a human reads.
  const base = totals(75_000, 25_000);
  const r = report({ today: base, directory: base, allTime: base });

  const parsed = JSON.parse(formatCostJson(r)) as { allTime: { cacheHitRate: number } };
  assert.equal(parsed.allTime.cacheHitRate, 0.75);
  assert.match(formatCostText(r), /75\.0%/);
});

// ---------------------------------------------------------------------------
// Scoping (the one part that genuinely needs the database)
// ---------------------------------------------------------------------------

test('scopes "this directory" to the directory', () => {
  const store = new SessionStore();
  const entry: ModelEntry = {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutput: 8192,
    pricing: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
    autoCache: true,
    subscription: false,
    local: false,
  };
  const use = { inputTokens: 1000, cachedInputTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 };

  const alpha = store.create('C:/projects/alpha', 'deepseek/deepseek-v4-pro');
  const beta = store.create('C:/projects/beta', 'deepseek/deepseek-v4-pro');
  for (let i = 0; i < 3; i++) store.recordUsage(alpha, use, 'deepseek/deepseek-v4-pro', entry);
  store.recordUsage(beta, use, 'deepseek/deepseek-v4-pro', entry);

  const fromAlpha = buildCostReport(store, 'C:/projects/alpha');
  assert.equal(fromAlpha.directory.requests, 3, 'must exclude other projects');
  assert.equal(fromAlpha.allTime.requests, 4, 'all-time spans every project');

  const fromBeta = buildCostReport(store, 'C:/projects/beta');
  assert.equal(fromBeta.directory.requests, 1);

  const unused = buildCostReport(store, 'C:/projects/never-touched');
  assert.equal(unused.directory.requests, 0);
  assert.equal(unused.allTime.requests, 4, 'an unused directory still shows global totals');
});
