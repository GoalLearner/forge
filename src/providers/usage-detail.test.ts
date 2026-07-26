/**
 * Provider usage → ledger mapping, against REAL response shapes.
 *
 * These fixtures are the actual `usage` objects the three dialects emit, not
 * idealized ones. The point of the test is the difference between them:
 * DeepSeek states the cache split outright, OpenAI states a total and a cached
 * subset, Anthropic states three separate input buckets, and every one of them
 * omits some field the others report. The ledger must never turn an omission
 * into a zero — that is the whole reason `TokenCount` is nullable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ledgerUsageFromOpenAI, normalizeOpenAIUsage } from './openai.ts';
import { buildUsage, knownTokenTotal } from '../session/ledger.ts';

describe('DeepSeek usage', () => {
  // Verbatim shape from api.deepseek.com with stream_options.include_usage.
  const deepseek = {
    prompt_tokens: 4321,
    completion_tokens: 187,
    total_tokens: 4508,
    prompt_cache_hit_tokens: 4160,
    prompt_cache_miss_tokens: 161,
  };

  test('takes both halves of the cache split as reported, not derived', () => {
    const u = ledgerUsageFromOpenAI(deepseek);
    assert.equal(u.cacheHitInput, 4160);
    assert.equal(u.cacheMissInput, 161);
    assert.equal(u.sources.cacheHitInput, 'reported');
    assert.equal(
      u.sources.cacheMissInput,
      'reported',
      'DeepSeek states the miss explicitly — deriving it would discard information',
    );
  });

  test('is complete, so a run built only from these can price exactly', () => {
    assert.equal(ledgerUsageFromOpenAI(deepseek).complete, true);
  });

  test('the two halves reconcile against the reported total', () => {
    const u = ledgerUsageFromOpenAI(deepseek);
    assert.equal((u.cacheHitInput ?? 0) + (u.cacheMissInput ?? 0), deepseek.prompt_tokens);
  });

  test('reasoning stays unknown — this model reports none', () => {
    const u = ledgerUsageFromOpenAI(deepseek);
    assert.equal(u.reasoningTokens, null);
    assert.equal(u.sources.reasoningTokens, 'unknown');
  });

  test('the ledger view agrees with the existing cost-path normalizer', () => {
    const n = normalizeOpenAIUsage(deepseek);
    const u = ledgerUsageFromOpenAI(deepseek);
    assert.equal(u.cacheHitInput, n.cachedInputTokens);
    assert.equal(u.cacheMissInput, n.inputTokens);
    assert.equal(u.outputTokens, n.outputTokens);
  });
});

describe('OpenAI-dialect usage', () => {
  // OpenAI / OpenRouter: a total, a cached subset, and reasoning broken out.
  const openai = {
    prompt_tokens: 3000,
    completion_tokens: 500,
    total_tokens: 3500,
    prompt_tokens_details: { cached_tokens: 2816 },
    completion_tokens_details: { reasoning_tokens: 320 },
  };

  test('derives the miss rather than pretending it was reported', () => {
    const u = ledgerUsageFromOpenAI(openai);
    assert.equal(u.cacheHitInput, 2816);
    assert.equal(u.cacheMissInput, 184, '3000 total - 2816 cached');
    assert.equal(u.sources.cacheMissInput, 'derived');
  });

  test('a derived split is still complete enough to price', () => {
    assert.equal(ledgerUsageFromOpenAI(openai).complete, true);
  });

  test('reasoning tokens are captured when the model reports them', () => {
    const u = ledgerUsageFromOpenAI(openai);
    assert.equal(u.reasoningTokens, 320);
    assert.equal(u.sources.reasoningTokens, 'reported');
  });

  test('a cached_tokens exceeding the total is flagged, not clamped', () => {
    const u = ledgerUsageFromOpenAI({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens: 10,
    });
    assert.ok(u.inconsistent, 'a self-contradicting provider must be recorded as such');
    assert.equal(u.cacheMissInput, null, 'no plausible-looking number is invented');
    assert.equal(u.complete, false, 'and it must not be treated as exactly priceable');
  });

  test('a provider that omits usage entirely yields nothing, not zeros', () => {
    const u = ledgerUsageFromOpenAI({});
    assert.equal(u.cacheHitInput, null);
    assert.equal(u.cacheMissInput, null);
    assert.equal(u.outputTokens, null);
    assert.equal(u.complete, false);
    assert.equal(knownTokenTotal(u), 0, 'total of nothing is 0, but the fields stay null');
  });
});

describe('Anthropic usage', () => {
  // message_start.usage — three input buckets that do NOT overlap.
  const anthropic = {
    input_tokens: 412,
    cache_read_input_tokens: 18_000,
    cache_creation_input_tokens: 1_200,
    output_tokens: 640,
  };

  // Mirrors the mapping in anthropic.ts:166.
  const mapped = buildUsage({
    cacheHitInput: anthropic.cache_read_input_tokens,
    cacheMissInput: anthropic.input_tokens,
    cacheWriteInput: anthropic.cache_creation_input_tokens,
    totalInput:
      anthropic.input_tokens +
      anthropic.cache_read_input_tokens +
      anthropic.cache_creation_input_tokens,
    outputTokens: anthropic.output_tokens,
    reasoningTokens: null,
  });

  test('keeps cache-write separate from both hit and miss', () => {
    assert.equal(mapped.cacheHitInput, 18_000);
    assert.equal(mapped.cacheMissInput, 412);
    assert.equal(mapped.cacheWriteInput, 1_200);
  });

  test('cache-write is billed on top, so it belongs in the known total', () => {
    assert.equal(knownTokenTotal(mapped), 18_000 + 412 + 1_200 + 640);
  });

  test('is complete despite reporting no reasoning tokens', () => {
    assert.equal(mapped.complete, true, 'reasoning is optional; the pricing inputs are all present');
    assert.equal(mapped.sources.reasoningTokens, 'unknown');
  });

  test('a first-call response with no cache fields still prices', () => {
    const cold = buildUsage({
      cacheHitInput: 0,
      cacheMissInput: 900,
      cacheWriteInput: 0,
      totalInput: 900,
      outputTokens: 100,
      reasoningTokens: null,
    });
    assert.equal(cold.complete, true);
    assert.equal(cold.cacheHitInput, 0);
    assert.equal(
      cold.sources.cacheHitInput,
      'reported',
      'a real zero from the provider is reported, unlike an omitted field',
    );
  });
});
