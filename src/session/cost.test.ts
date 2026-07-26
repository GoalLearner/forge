/**
 * Cost accounting tests.
 *
 * The failure this guards against is subtle and one-directional: if cached
 * tokens are double-counted (or counted as uncached), the reported cost is
 * *wrong in the flattering direction* — you think caching is working when it
 * isn't. Since the whole product thesis is "caching makes this cheap", a cost
 * report that lies is worse than no cost report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOpenAIUsage } from '../providers/openai.ts';
import {
  addUsage,
  cacheHitRate,
  computeCost,
  computeUncachedCost,
  EMPTY_TOTALS,
  formatCost,
} from './cost.ts';
import type { ModelEntry } from '../config/schema.ts';
import type { NormalizedUsage } from '../providers/types.ts';

const DEEPSEEK: ModelEntry = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  contextWindow: 1_000_000,
  maxOutput: 8192,
  pricing: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  autoCache: true,
  subscription: false,
  local: false,
};

const OPUS: ModelEntry = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  contextWindow: 1_000_000,
  maxOutput: 8192,
  pricing: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  autoCache: false,
  subscription: false,
  local: false,
};

// ---------------------------------------------------------------------------
// Usage normalization — three provider dialects, one shape
// ---------------------------------------------------------------------------

test('normalizes DeepSeek hit/miss partitioning', () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 10_000,
    prompt_cache_hit_tokens: 9_000,
    prompt_cache_miss_tokens: 1_000,
    completion_tokens: 500,
  });

  assert.equal(usage.cachedInputTokens, 9_000);
  assert.equal(usage.inputTokens, 1_000, 'inputTokens is the UNCACHED remainder');
  assert.equal(usage.outputTokens, 500);
  assert.equal(
    usage.inputTokens + usage.cachedInputTokens,
    10_000,
    'the parts must sum to the reported prompt size — no double counting',
  );
});

test('normalizes DeepSeek when only the hit count is reported', () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 10_000,
    prompt_cache_hit_tokens: 6_000,
    completion_tokens: 100,
  });
  assert.equal(usage.inputTokens, 4_000, 'the miss count must be derived, not assumed zero');
});

test('normalizes the OpenAI-standard cached_tokens dialect (GLM, Kimi)', () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 8_000,
    prompt_tokens_details: { cached_tokens: 6_000 },
    completion_tokens: 300,
  });
  assert.equal(usage.cachedInputTokens, 6_000);
  assert.equal(usage.inputTokens, 2_000);
});

test('handles a provider that reports no cache fields at all', () => {
  const usage = normalizeOpenAIUsage({ prompt_tokens: 500, completion_tokens: 50 });
  assert.equal(usage.cachedInputTokens, 0);
  assert.equal(usage.inputTokens, 500);
});

test('never produces negative token counts from inconsistent provider data', () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 500 },
    completion_tokens: 10,
  });
  assert.ok(usage.inputTokens >= 0, 'a negative count would corrupt every downstream total');
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('prices cached and uncached input at their different rates', () => {
  const usage: NormalizedUsage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  };
  const cost = computeCost(usage, DEEPSEEK);

  assert.ok(Math.abs(cost.inputCost - 0.14) < 1e-9);
  assert.ok(Math.abs(cost.cachedInputCost - 0.0028) < 1e-9);
  assert.ok(Math.abs(cost.outputCost - 0.28) < 1e-9);
  assert.ok(Math.abs(cost.total - 0.4228) < 1e-9);
});

test('quantifies the caching saving — the number that justifies the design', () => {
  // A realistic multi-turn shape: most of the prompt is a cache hit.
  const usage: NormalizedUsage = {
    inputTokens: 2_000,
    cachedInputTokens: 98_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000,
  };

  const cached = computeCost(usage, DEEPSEEK).total;
  const uncached = computeUncachedCost(usage, DEEPSEEK);

  assert.ok(uncached > cached * 10, `expected a large saving, got ${uncached} vs ${cached}`);
});

test('applies Anthropic cache-write pricing', () => {
  const usage: NormalizedUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 1_000_000,
    outputTokens: 0,
  };
  assert.ok(Math.abs(computeCost(usage, OPUS).cacheWriteCost - 6.25) < 1e-9);
});

test('falls back to 1.25x input when a catalog entry omits cacheWrite', () => {
  const entry: ModelEntry = { ...OPUS, pricing: { input: 4, cachedInput: 0.4, output: 20 } };
  const usage: NormalizedUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 1_000_000,
    outputTokens: 0,
  };
  assert.ok(Math.abs(computeCost(usage, entry).cacheWriteCost - 5) < 1e-9);
});

test('subscription models price at zero', () => {
  const entry: ModelEntry = {
    ...DEEPSEEK,
    provider: 'zai-coding-plan',
    pricing: { input: 0, cachedInput: 0, output: 0 },
    subscription: true,
  };
  const usage: NormalizedUsage = {
    inputTokens: 500_000,
    cachedInputTokens: 500_000,
    cacheWriteTokens: 0,
    outputTokens: 100_000,
  };
  assert.equal(computeCost(usage, entry).total, 0);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('accumulates totals across requests', () => {
  const usage: NormalizedUsage = {
    inputTokens: 100,
    cachedInputTokens: 900,
    cacheWriteTokens: 0,
    outputTokens: 50,
  };
  let totals = addUsage(EMPTY_TOTALS, usage, DEEPSEEK);
  totals = addUsage(totals, usage, DEEPSEEK);

  assert.equal(totals.requests, 2);
  assert.equal(totals.inputTokens, 200);
  assert.equal(totals.cachedInputTokens, 1_800);
  assert.ok(totals.uncachedCost > totals.cost);
});

test('cache hit rate counts writes in the denominator only', () => {
  // Writes are what you pay to enable future reads. Counting them as hits would
  // flatter the number and hide a prefix that is being rewritten every turn.
  const totals = addUsage(
    EMPTY_TOTALS,
    { inputTokens: 0, cachedInputTokens: 50, cacheWriteTokens: 50, outputTokens: 0 },
    OPUS,
  );
  assert.equal(cacheHitRate(totals), 0.5);
});

test('cache hit rate is zero, not NaN, for an empty session', () => {
  assert.equal(cacheHitRate(EMPTY_TOTALS), 0);
});

test('formats sub-cent amounts with enough precision to be useful', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.000123), '$0.00012');
  assert.equal(formatCost(0.0523), '$0.0523');
  assert.equal(formatCost(12.3456), '$12.35');
});
