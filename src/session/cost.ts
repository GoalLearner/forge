/**
 * Cost accounting.
 *
 * The headline number in `/cost` is not the dollar total — it is the CACHE HIT
 * RATE. That single percentage tells you whether the design in
 * agent/messages.ts is actually working:
 *
 *   - 70-95% on a multi-turn task: healthy, everything is working as intended
 *   - ~0% after several turns:     the prefix is being invalidated somewhere.
 *                                  On DeepSeek that is a 50x cost difference.
 *
 * The dollar figure is an estimate. It comes from prices in models.json, which
 * are seeded from each provider's published rates and are guaranteed to drift —
 * DeepSeek deprecated two model IDs the day before this was written. Treat it
 * as an order-of-magnitude signal, and check your provider's dashboard for the
 * authoritative number.
 */

import type { ModelEntry } from '../config/schema.ts';
import type { NormalizedUsage } from '../providers/types.ts';

export interface CostBreakdown {
  inputCost: number;
  cachedInputCost: number;
  cacheWriteCost: number;
  outputCost: number;
  total: number;
}

/**
 * Price one request.
 *
 * Note that `cacheWrite` only applies to Anthropic — the cheap providers
 * populate their caches for free, which is a large part of why they are cheap
 * in an agent loop specifically.
 */
export function computeCost(usage: NormalizedUsage, entry: ModelEntry): CostBreakdown {
  const perMillion = (tokens: number, price: number): number => (tokens / 1_000_000) * price;

  const inputCost = perMillion(usage.inputTokens, entry.pricing.input);
  const cachedInputCost = perMillion(usage.cachedInputTokens, entry.pricing.cachedInput);
  const cacheWriteCost = perMillion(
    usage.cacheWriteTokens,
    // Anthropic's 5-minute cache write is 1.25x the base input rate. Fall back
    // to that ratio if a catalog entry omits the explicit price.
    entry.pricing.cacheWrite ?? entry.pricing.input * 1.25,
  );
  const outputCost = perMillion(usage.outputTokens, entry.pricing.output);

  return {
    inputCost,
    cachedInputCost,
    cacheWriteCost,
    outputCost,
    total: inputCost + cachedInputCost + cacheWriteCost + outputCost,
  };
}

/**
 * What the same request would have cost with no prompt cache at all.
 *
 * This is what makes the savings legible: "you spent $0.03; without caching
 * this would have been $1.40". Cached tokens and cache-written tokens are both
 * repriced at the full input rate.
 */
export function computeUncachedCost(usage: NormalizedUsage, entry: ModelEntry): number {
  const totalInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  return (
    (totalInput / 1_000_000) * entry.pricing.input +
    (usage.outputTokens / 1_000_000) * entry.pricing.output
  );
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cost: number;
  /** What it would have cost with no caching, for the savings line. */
  uncachedCost: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  cost: 0,
  uncachedCost: 0,
};

export function addUsage(
  totals: UsageTotals,
  usage: NormalizedUsage,
  entry: ModelEntry,
): UsageTotals {
  return {
    requests: totals.requests + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    cachedInputTokens: totals.cachedInputTokens + usage.cachedInputTokens,
    cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cost: totals.cost + computeCost(usage, entry).total,
    uncachedCost: totals.uncachedCost + computeUncachedCost(usage, entry),
  };
}

/**
 * Share of input tokens served from cache, 0..1.
 *
 * Cache *writes* count in the denominator but not the numerator: writing is
 * what you pay to enable future reads, so counting it as a hit would flatter
 * the number and hide a prefix that is being rewritten every turn.
 */
export function cacheHitRate(totals: UsageTotals): number {
  const denominator = totals.inputTokens + totals.cachedInputTokens + totals.cacheWriteTokens;
  return denominator === 0 ? 0 : totals.cachedInputTokens / denominator;
}

/** Format small amounts usefully — most turns cost far less than a cent. */
export function formatCost(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
