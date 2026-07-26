/**
 * Ledger accounting invariants.
 *
 * The single property every test here defends: **Forge must never present an
 * unknown number as a settled one.** Before this module, a stream that died
 * before reporting usage and a genuinely free request both rendered as
 * `$0.00`, and a model with no configured price rendered the same way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RetryBudget,
  RunLedger,
  UNKNOWN_USAGE,
  NO_BILLABLE_USAGE,
  aggregateCost,
  aggregateSession,
  buildUsage,
  clampDiagnostic,
  formatLedgerCost,
  knownTokenTotal,
  nanosToUsd,
  priceTokens,
  priceUsage,
  snapshotPricing,
  type CostResult,
  type PricingSnapshot,
  type ProviderAttempt,
} from './ledger.ts';
import type { ModelEntry } from '../config/schema.ts';

const ENTRY: ModelEntry = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  contextWindow: 200_000,
  maxOutput: 32_000,
  pricing: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  autoCache: true,
  subscription: false,
  local: false,
};

const PRICING = snapshotPricing('deepseek/deepseek-v4-pro', ENTRY);

const attempt = (over: Partial<ProviderAttempt> = {}): Omit<
  ProviderAttempt,
  'runId' | 'requestIndex' | 'attemptIndex'
> => ({
  retryIndex: 0,
  provider: 'deepseek',
  requestedModel: 'deepseek/deepseek-v4-pro',
  returnedModel: null,
  startedAt: 0,
  endedAt: 10,
  durationMs: 10,
  dispatched: true,
  streamStarted: true,
  streamCompleted: true,
  outcome: 'success',
  retryable: null,
  errorCategory: null,
  errorMessage: null,
  retryDelayMs: null,
  usage: buildUsage({ cacheHitInput: 100, totalInput: 200, outputTokens: 50 }),
  pricing: PRICING,
  cost: { state: 'estimated', nanos: 1000, tokens: 250 },
  ...over,
});

// --- usage normalization ---------------------------------------------------

test('missing usage is unknown, never zero', () => {
  const u = buildUsage({});
  assert.equal(u.cacheHitInput, null);
  assert.equal(u.outputTokens, null);
  assert.equal(u.complete, false);
});

test('a provider-reported zero stays zero', () => {
  const u = buildUsage({ cacheHitInput: 0, totalInput: 0, outputTokens: 0 });
  assert.equal(u.cacheHitInput, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.sources.cacheHitInput, 'reported');
  assert.equal(u.complete, true, 'a real zero is complete information');
});

test('absent reasoning tokens stay unknown rather than zero', () => {
  const u = buildUsage({ cacheHitInput: 1, totalInput: 2, outputTokens: 3 });
  assert.equal(u.reasoningTokens, null);
  assert.equal(u.sources.reasoningTokens, 'unknown');
});

test('cache-miss is derived only from valid complete fields, and marked derived', () => {
  const u = buildUsage({ cacheHitInput: 300, totalInput: 1000, outputTokens: 40 });
  assert.equal(u.cacheMissInput, 700);
  assert.equal(u.sources.cacheMissInput, 'derived');

  const reported = buildUsage({ cacheHitInput: 300, cacheMissInput: 650, totalInput: 950, outputTokens: 1 });
  assert.equal(reported.sources.cacheMissInput, 'reported', 'a reported value is never overwritten');
});

test('cache-miss is NOT derived when the total is missing', () => {
  const u = buildUsage({ cacheHitInput: 300, outputTokens: 40 });
  assert.equal(u.cacheMissInput, null);
  assert.equal(u.complete, false);
});

test('contradictory usage is flagged, not clamped to a plausible number', () => {
  const u = buildUsage({ cacheHitInput: 900, totalInput: 100, outputTokens: 5 });
  assert.equal(u.cacheMissInput, null, 'no negative count is invented');
  assert.ok(u.inconsistent, 'the contradiction is recorded');
  assert.equal(u.complete, false);
});

test('an attempt that delivered nothing is known-zero, not incomplete', () => {
  assert.equal(NO_BILLABLE_USAGE.complete, true);
  // Every count that feeds pricing is a reported zero, so this is the one
  // genuinely certain figure in the whole ledger.
  assert.equal(priceUsage(NO_BILLABLE_USAGE, PRICING).state, 'known');
  assert.equal(priceUsage(NO_BILLABLE_USAGE, PRICING).nanos, 0);
});

// --- money -----------------------------------------------------------------

test('token pricing is exact integer nanodollars', () => {
  // $0.435 per 1M tokens = 4.35e-7 USD/token = 435 nanodollars per token.
  assert.equal(priceTokens(1, 0.435), 435);
  assert.equal(priceTokens(1_000, 0.435), 435_000);
  // A full million tokens is exactly $0.435 = 435,000,000 nanodollars.
  assert.equal(priceTokens(1_000_000, 0.435), 435_000_000);
  assert.equal(nanosToUsd(priceTokens(1_000_000, 0.435)), 0.435);
  assert.equal(priceTokens(0, 0.435), 0);
});

test('invalid pricing and token counts cannot produce a charge', () => {
  assert.equal(priceTokens(-5, 1), 0);
  assert.equal(priceTokens(10, -1), 0);
  assert.equal(priceTokens(Number.NaN, 1), 0);
  assert.equal(priceTokens(10, Number.POSITIVE_INFINITY), 0);
});

test('summation does not drift the way float dollars would', () => {
  // 10,000 cheap requests. In float USD this accumulates visible error.
  let nanos = 0;
  for (let i = 0; i < 10_000; i++) nanos += priceTokens(137, 0.435);
  assert.equal(nanos, 10_000 * priceTokens(137, 0.435), 'integers sum exactly');
  assert.equal(Number.isInteger(nanos), true);
});

// --- cost states -----------------------------------------------------------

test('complete usage with pricing is estimated, never known', () => {
  const cost = priceUsage(buildUsage({ cacheHitInput: 100, totalInput: 1_100, outputTokens: 500 }), PRICING);
  assert.equal(cost.state, 'estimated', 'locally computed cost is not provider-quoted');
  assert.ok(cost.nanos > 0);
});

test('incomplete usage yields a lower bound, not a total', () => {
  const partial = buildUsage({ cacheHitInput: 100, totalInput: 1_100 }); // no output
  const cost = priceUsage(partial, PRICING);
  assert.equal(cost.state, 'incomplete');
  assert.ok(cost.nanos > 0, 'what is known is still priced');
});

test('complete usage without pricing is unpriced, not free', () => {
  const cost = priceUsage(buildUsage({ cacheHitInput: 0, totalInput: 900, outputTokens: 100 }), null);
  assert.equal(cost.state, 'unpriced');
  assert.equal(cost.nanos, 0);
  assert.equal(cost.tokens, 1_000, 'the tokens are still reported');
});

test('a subscription model prices to a genuine zero', () => {
  const flat: PricingSnapshot = { ...PRICING, subscription: true };
  const cost = priceUsage(buildUsage({ cacheHitInput: 5, totalInput: 10, outputTokens: 10 }), flat);
  assert.equal(cost.state, 'estimated');
  assert.equal(cost.nanos, 0);
});

test('reasoning tokens are not double-charged without an explicit rate', () => {
  const withReasoning = buildUsage({
    cacheHitInput: 0, totalInput: 100, outputTokens: 200, reasoningTokens: 150,
  });
  const without = buildUsage({ cacheHitInput: 0, totalInput: 100, outputTokens: 200 });
  assert.equal(
    priceUsage(withReasoning, PRICING).nanos,
    priceUsage(without, PRICING).nanos,
    'reasoning is already inside completion_tokens',
  );
});

// --- aggregate precedence --------------------------------------------------

const c = (state: CostResult['state'], nanos = 100, tokens = 10): CostResult => ({ state, nanos, tokens });

test('aggregate precedence: incomplete beats everything', () => {
  assert.equal(aggregateCost([c('estimated'), c('unpriced'), c('incomplete')]).state, 'incomplete');
  assert.equal(aggregateCost([c('known'), c('incomplete')]).state, 'incomplete');
});

test('aggregate precedence: unpriced beats estimated and known', () => {
  assert.equal(aggregateCost([c('estimated'), c('unpriced')]).state, 'unpriced');
  assert.equal(aggregateCost([c('known'), c('unpriced')]).state, 'unpriced');
});

test('mixed known and estimated is estimated, not known', () => {
  assert.equal(aggregateCost([c('known'), c('estimated')]).state, 'estimated');
});

test('all-known stays known; nothing at all is incomplete', () => {
  assert.equal(aggregateCost([c('known'), c('known')]).state, 'known');
  // Not 'estimated': that would claim we worked out a cost of zero. An empty
  // set supports no claim, so the honest answer is "cannot state a total".
  assert.equal(aggregateCost([]).state, 'incomplete');
  assert.equal(aggregateCost([]).nanos, 0);
});

test('aggregation sums nanos and tokens exactly', () => {
  const total = aggregateCost([c('estimated', 100, 5), c('estimated', 250, 7)]);
  assert.equal(total.nanos, 350);
  assert.equal(total.tokens, 12);
});

// --- display ---------------------------------------------------------------

test('unknown and unpriced never render as $0.00', () => {
  assert.equal(formatLedgerCost({ state: 'incomplete', nanos: 0, tokens: 0 }), 'Usage unavailable');
  assert.match(formatLedgerCost({ state: 'incomplete', nanos: 3_200_000, tokens: 9 }), /^At least \$/);
  assert.match(formatLedgerCost({ state: 'unpriced', nanos: 0, tokens: 12_430 }), /^Unpriced — 12,430 tokens$/);
  assert.match(formatLedgerCost({ state: 'estimated', nanos: 3_200_000, tokens: 9 }), /estimated$/);
});

test('a genuine zero may still render as $0.00', () => {
  // Only reachable when usage is complete and priced — e.g. a subscription.
  assert.equal(formatLedgerCost({ state: 'estimated', nanos: 0, tokens: 0 }), '$0.00 estimated');
});

// --- ledger structure ------------------------------------------------------

test('attempts group under logical requests; tool follow-up starts a new one', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));

  ledger.beginRequest();
  ledger.recordAttempt(attempt({ retryIndex: 0, outcome: 'retryable_error' }));
  ledger.recordAttempt(attempt({ retryIndex: 1 }));

  ledger.beginRequest(); // tool results sent back — a NEW logical request
  ledger.recordAttempt(attempt({ retryIndex: 0 }));

  const reqs = ledger.requestSummaries();
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.attempts), [2, 1]);
  assert.deepEqual(reqs.map((r) => r.retries), [1, 0]);
  assert.equal(ledger.summary().providerAttempts, 3);
  assert.equal(ledger.summary().logicalRequests, 2);
});

test('every attempt is recorded exactly once, including failures', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt({ outcome: 'retryable_error' }));
  ledger.recordAttempt(attempt({ outcome: 'cancelled', retryIndex: 1 }));
  ledger.recordAttempt(attempt({ outcome: 'not_dispatched', dispatched: false, retryIndex: 2 }));

  const all = ledger.allAttempts();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((a) => a.attemptIndex), [1, 2, 3]);
});

test('a failed attempt WITH usage still contributes cost', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt({ outcome: 'retryable_error', cost: { state: 'estimated', nanos: 500, tokens: 5 } }));
  ledger.recordAttempt(attempt({ retryIndex: 1, cost: { state: 'estimated', nanos: 700, tokens: 7 } }));
  assert.equal(ledger.summary().cost.nanos, 1_200, 'retries are billed too');
});

test('a dispatched attempt with no usage makes the run incomplete', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt({ cost: { state: 'estimated', nanos: 900, tokens: 9 } }));
  ledger.recordAttempt(attempt({
    retryIndex: 1, outcome: 'cancelled', streamCompleted: false,
    usage: UNKNOWN_USAGE, cost: { state: 'incomplete', nanos: 0, tokens: 0 },
  }));

  const s = ledger.summary();
  assert.equal(s.cost.state, 'incomplete');
  assert.equal(s.cost.nanos, 900, 'the known part survives as a lower bound');
});

test('token totals stay null when nothing reported them', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt({ usage: UNKNOWN_USAGE, cost: { state: 'incomplete', nanos: 0, tokens: 0 } }));
  assert.equal(ledger.summary().outputTokens, null, 'unknown must not sum to 0');
});

test('a finalized ledger cannot be mutated, and finalization is idempotent', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt());

  const first = ledger.finalize();
  ledger.recordAttempt(attempt({ cost: { state: 'estimated', nanos: 99_999, tokens: 1 } }));
  ledger.beginRequest();
  const second = ledger.finalize();

  assert.equal(ledger.allAttempts().length, 1, 'late events cannot be appended');
  assert.equal(first.providerAttempts, second.providerAttempts);
  assert.equal(first.cost.nanos, second.cost.nanos);
  assert.equal(second.finalized, true);
});

test('allAttempts returns a copy — callers cannot reach inside', () => {
  const ledger = new RunLedger('run_1', new RetryBudget(2));
  ledger.beginRequest();
  ledger.recordAttempt(attempt());
  (ledger.allAttempts() as ProviderAttempt[]).push(attempt() as ProviderAttempt);
  assert.equal(ledger.allAttempts().length, 1);
});

test('diagnostics are bounded and flattened', () => {
  const long = 'x'.repeat(5_000);
  const clamped = clampDiagnostic(long)!;
  assert.ok(clamped.length < 250);
  assert.equal(clampDiagnostic('a\n\n  b'), 'a b');
  assert.equal(clampDiagnostic(null), null);
});

// --- session aggregation ---------------------------------------------------

test('session totals never double-count a run', () => {
  const budget = new RetryBudget(2);
  const a = new RunLedger('run_a', budget);
  a.beginRequest();
  a.recordAttempt(attempt({ cost: { state: 'estimated', nanos: 1_000, tokens: 10 } }));
  const sa = a.finalize();

  const total = aggregateSession([sa, sa, sa]);
  assert.equal(total.runs, 1);
  assert.equal(total.cost.nanos, 1_000);
});

test('a new run starts empty with a fresh retry budget', () => {
  const first = new RunLedger('run_a', new RetryBudget(2));
  first.beginRequest();
  first.recordAttempt(attempt());
  first.retryBudget.consume();
  first.finalize();

  const second = new RunLedger('run_b', new RetryBudget(2));
  assert.equal(second.allAttempts().length, 0);
  assert.equal(second.retryBudget.consumed, 0);
  assert.equal(second.retryBudget.remaining, 2);
});

test('session confidence degrades to the weakest run', () => {
  const mk = (id: string, cost: CostResult): ReturnType<RunLedger['finalize']> => {
    const l = new RunLedger(id, new RetryBudget(2));
    l.beginRequest();
    l.recordAttempt(attempt({ cost }));
    return l.finalize();
  };
  const totals = aggregateSession([
    mk('r1', c('estimated', 500, 5)),
    mk('r2', c('incomplete', 100, 1)),
  ]);
  assert.equal(totals.cost.state, 'incomplete');
});

// --- retry budget ----------------------------------------------------------

test('the retry budget is shared and does not reset', () => {
  const b = new RetryBudget(2);
  assert.equal(b.canRetry(), true);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), true);
  assert.equal(b.canRetry(), false, 'exhausted after 2');
  assert.equal(b.consume(), false, 'cannot overspend');
  assert.equal(b.consumed, 2);
  assert.equal(b.remaining, 0);
});

test('a zero budget permits no retries at all', () => {
  const b = new RetryBudget(0);
  assert.equal(b.canRetry(), false);
  assert.equal(b.consume(), false);
});

test('knownTokenTotal ignores unknown fields without inventing zeros', () => {
  assert.equal(knownTokenTotal(UNKNOWN_USAGE), 0);
  assert.equal(knownTokenTotal(buildUsage({ cacheHitInput: 10, totalInput: 30, outputTokens: 5 })), 35);
});
