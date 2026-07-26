/**
 * The usage and cost ledger.
 *
 * One question drives this whole module: **when Forge shows you a number, can
 * you trust it?** The accounting that existed before this could not answer
 * that, because it collapsed three very different situations into the same
 * output:
 *
 *   - the provider told us 1,200 output tokens          → we showed a cost
 *   - the provider told us nothing (stream died early)  → we showed $0.00
 *   - the model has no configured price                 → we showed $0.00
 *
 * The last two are lies. A run that cost real money reads as free, and a
 * missing field is indistinguishable from a genuine zero. So the rules here are
 * deliberately pessimistic:
 *
 *   MISSING IS NOT ZERO. Every token count is nullable. `null` means "the
 *   provider did not tell us", `0` means "the provider said zero". Nothing is
 *   estimated from character counts, reasoning-text length, or cache
 *   percentages shown elsewhere in the UI.
 *
 *   EVERY DISPATCHED ATTEMPT COUNTS. A retry that failed still burned tokens.
 *   A cancelled stream may have billed for what it produced. Both appear in the
 *   ledger; only a failure proven to happen *before* dispatch is free.
 *
 *   COST CARRIES ITS CONFIDENCE. `estimated` (we did the maths locally),
 *   `incomplete` (something billable is unaccounted for), `unpriced` (no rate
 *   configured), `known` (the provider itself quoted a price — nothing does
 *   today, so this state is defined but currently unreachable).
 *
 * Money is integer nanodollars throughout. DeepSeek input runs at $0.14/M —
 * 1.4e-7 per token — and repeatedly adding numbers that small as float64 drifts
 * in a way that is invisible per request and wrong by the end of a session.
 */

import type { ModelEntry } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Integer nanodollars (1e-9 USD).
 *
 * Chosen over microdollars because a single DeepSeek input token costs 140
 * nanodollars — at 1e-6 resolution that rounds to zero and a whole cheap
 * request disappears. A session would have to spend ~$9,000,000 before this
 * leaves the safe-integer range.
 */
export type Nanodollars = number;

/** USD-per-million-tokens → nanodollars for `tokens`, rounded once. */
export function priceTokens(tokens: number, usdPerMillion: number): Nanodollars {
  if (!Number.isFinite(tokens) || tokens < 0) return 0;
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) return 0;
  // usd/1e6 per token, expressed in nanodollars, is `usdPerMillion * 1000`.
  return Math.round(tokens * usdPerMillion * 1000);
}

export function nanosToUsd(nanos: Nanodollars): number {
  return nanos / 1_000_000_000;
}

/**
 * Display a cost with its confidence, never as a bare `$0.00`.
 *
 * The formatting IS the honesty guarantee: an unknown cost must not be able to
 * render as a number that looks settled.
 */
export function formatLedgerCost(cost: CostResult): string {
  switch (cost.state) {
    case 'known':
    case 'estimated': {
      const suffix = cost.state === 'estimated' ? ' estimated' : '';
      return `${formatUsd(cost.nanos)}${suffix}`;
    }
    case 'incomplete':
      // A lower bound is still useful — it just must not claim to be the total.
      return cost.nanos > 0
        ? `At least ${formatUsd(cost.nanos)} — usage incomplete`
        : 'Usage unavailable';
    case 'unpriced':
      return cost.tokens > 0
        ? `Unpriced — ${cost.tokens.toLocaleString()} tokens`
        : 'Unpriced';
  }
}

/** Bare monetary formatting. Sub-cent amounts keep enough digits to be useful. */
export function formatUsd(nanos: Nanodollars): string {
  const usd = nanosToUsd(nanos);
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** `null` = the provider did not report it. `0` = the provider reported zero. */
export type TokenCount = number | null;

/** Where a value came from, so "derived" is never mistaken for "reported". */
export type UsageSource = 'reported' | 'derived' | 'unknown';

export interface LedgerUsage {
  /** Input tokens served from the provider's prompt cache. */
  cacheHitInput: TokenCount;
  /** Input tokens that were NOT cache hits — the expensive ones. */
  cacheMissInput: TokenCount;
  /** Anthropic only: tokens written into the cache, billed at a premium. */
  cacheWriteInput: TokenCount;
  /** Total input as the provider reported it, when it does. */
  totalInput: TokenCount;
  outputTokens: TokenCount;
  /** Only when a provider reports it separately. Never inferred from text. */
  reasoningTokens: TokenCount;

  /** Per-field provenance for the two values we sometimes compute. */
  sources: {
    cacheHitInput: UsageSource;
    cacheMissInput: UsageSource;
    outputTokens: UsageSource;
    reasoningTokens: UsageSource;
  };

  /**
   * True when the fields needed to price this attempt are all present.
   * False forces the attempt — and everything aggregating it — to `incomplete`.
   */
  complete: boolean;
  /** Set when provider numbers contradict each other (e.g. hits > total). */
  inconsistent?: string;
}

export const UNKNOWN_USAGE: LedgerUsage = Object.freeze<LedgerUsage>({
  cacheHitInput: null,
  cacheMissInput: null,
  cacheWriteInput: null,
  totalInput: null,
  outputTokens: null,
  reasoningTokens: null,
  sources: {
    cacheHitInput: 'unknown',
    cacheMissInput: 'unknown',
    outputTokens: 'unknown',
    reasoningTokens: 'unknown',
  },
  complete: false,
});

/**
 * Usage for an attempt that provably delivered no billable tokens.
 *
 * Two cases qualify, and the second is the load-bearing one:
 *
 *   - the request never reached the network at all, and
 *   - it reached the provider but failed before a single stream event arrived
 *     (429, 5xx, refused connection, DNS failure).
 *
 * Billing is per token delivered, so zero events means zero cost — a fact, not
 * an optimistic guess. This is the one place zero is asserted rather than
 * withheld, and drawing the line at "did anything stream" is what keeps it
 * defensible: an attempt that broke MID-stream may well have been billed for
 * what it already produced, and that case is recorded as `UNKNOWN_USAGE`.
 *
 * The alternative — treating every transient failure as `incomplete` — would
 * mark a run's cost untrustworthy because of a single routine 429, which is the
 * most common event in the system. That destroys the signal precisely when the
 * cost figure is otherwise perfectly good.
 */
export const NO_BILLABLE_USAGE: LedgerUsage = Object.freeze<LedgerUsage>({
  cacheHitInput: 0,
  cacheMissInput: 0,
  cacheWriteInput: 0,
  totalInput: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  sources: {
    cacheHitInput: 'reported',
    cacheMissInput: 'reported',
    outputTokens: 'reported',
    reasoningTokens: 'unknown',
  },
  complete: true,
});

/** Sum of every token we know about — used for the `unpriced` display. */
export function knownTokenTotal(usage: LedgerUsage): number {
  return (
    (usage.cacheHitInput ?? 0) +
    (usage.cacheMissInput ?? 0) +
    (usage.cacheWriteInput ?? 0) +
    (usage.outputTokens ?? 0)
  );
}

/**
 * Build usage from whatever a provider actually reported.
 *
 * `cacheMissInput` is derived ONLY as `totalInput - cacheHitInput`, and only
 * when both are present and the result is non-negative. A negative result means
 * the provider contradicted itself; that is recorded as inconsistent rather
 * than clamped to a plausible-looking number.
 */
export function buildUsage(input: {
  cacheHitInput?: number | null;
  cacheMissInput?: number | null;
  cacheWriteInput?: number | null;
  totalInput?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
}): LedgerUsage {
  const hit = num(input.cacheHitInput);
  const write = num(input.cacheWriteInput);
  const total = num(input.totalInput);
  const output = num(input.outputTokens);
  const reasoning = num(input.reasoningTokens);

  let miss = num(input.cacheMissInput);
  let missSource: UsageSource = miss === null ? 'unknown' : 'reported';
  let inconsistent: string | undefined;

  if (miss === null && total !== null && hit !== null) {
    const derived = total - hit;
    if (derived >= 0) {
      miss = derived;
      missSource = 'derived';
    } else {
      inconsistent = 'cache-hit input exceeds reported total input';
    }
  }

  // Pricing needs the input split and the output count. Cache-write is
  // Anthropic-only and legitimately absent elsewhere, so it is not required.
  const complete = hit !== null && miss !== null && output !== null && !inconsistent;

  return {
    cacheHitInput: hit,
    cacheMissInput: miss,
    cacheWriteInput: write,
    totalInput: total,
    outputTokens: output,
    reasoningTokens: reasoning,
    sources: {
      cacheHitInput: hit === null ? 'unknown' : 'reported',
      cacheMissInput: missSource,
      outputTokens: output === null ? 'unknown' : 'reported',
      reasoningTokens: reasoning === null ? 'unknown' : 'reported',
    },
    complete,
    ...(inconsistent ? { inconsistent } : {}),
  };
}

function num(v: number | null | undefined): TokenCount {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * The rates used for one attempt, captured at the time of the call.
 *
 * Stored per attempt so that editing `models.json` later cannot silently
 * rewrite what a run in the past appeared to cost.
 */
export interface PricingSnapshot {
  modelKey: string;
  /** USD per million tokens. */
  input: number;
  cachedInput: number;
  cacheWrite: number | null;
  output: number;
  /** Only when the catalog defines a distinct reasoning rate. */
  reasoning: number | null;
  /** Flat-rate plan: tokens are already paid for. */
  subscription: boolean;
}

export function snapshotPricing(modelKey: string, entry: ModelEntry): PricingSnapshot {
  return {
    modelKey,
    input: entry.pricing.input,
    cachedInput: entry.pricing.cachedInput,
    cacheWrite: entry.pricing.cacheWrite ?? null,
    output: entry.pricing.output,
    // The catalog has no reasoning rate today. Left null deliberately rather
    // than defaulting to the output rate — see priceUsage().
    reasoning: null,
    subscription: entry.subscription,
  };
}

export type CostState = 'known' | 'estimated' | 'incomplete' | 'unpriced';

export interface CostResult {
  state: CostState;
  /** Nanodollars. For `incomplete` this is a lower bound, not the total. */
  nanos: Nanodollars;
  /** Tokens counted — used to make `unpriced` meaningful. */
  tokens: number;
}

/**
 * Price one attempt's usage.
 *
 * Reasoning tokens are deliberately NOT charged separately: every provider
 * Forge currently supports reports them as a subset of `completion_tokens`,
 * already billed at the output rate. Adding a second charge would double-count.
 * If a catalog entry ever gains an explicit reasoning rate, `snapshotPricing`
 * populates it and this is where it would apply.
 */
export function priceUsage(usage: LedgerUsage, pricing: PricingSnapshot | null): CostResult {
  const tokens = knownTokenTotal(usage);

  if (!usage.complete) {
    // Price whatever IS known, and label it a lower bound.
    const partial = pricing ? partialNanos(usage, pricing) : 0;
    return { state: 'incomplete', nanos: partial, tokens };
  }

  if (!pricing) return { state: 'unpriced', nanos: 0, tokens };

  // A subscription plan has already been paid for; the marginal figure is zero
  // but it is not a quoted cost, so it stays an estimate.
  if (pricing.subscription) return { state: 'estimated', nanos: 0, tokens };

  const nanos = partialNanos(usage, pricing);

  // `known` vs `estimated` turns on whether any token count was inferred rather
  // than stated. This is the whole reason `sources` is carried around: DeepSeek
  // reports the cache hit AND miss, so its figure rests entirely on numbers the
  // provider sent; an OpenAI-dialect response states a total and a cached
  // subset, so the miss is our subtraction and the total inherits that. Only
  // the three counts that actually feed pricing are consulted — a missing
  // reasoning breakdown changes no arithmetic and must not downgrade the label.
  const derived =
    usage.sources.cacheHitInput !== 'reported' ||
    usage.sources.cacheMissInput !== 'reported' ||
    usage.sources.outputTokens !== 'reported';

  return { state: derived ? 'estimated' : 'known', nanos, tokens };
}

function partialNanos(usage: LedgerUsage, pricing: PricingSnapshot): Nanodollars {
  if (pricing.subscription) return 0;
  let nanos = 0;
  if (usage.cacheHitInput !== null) nanos += priceTokens(usage.cacheHitInput, pricing.cachedInput);
  if (usage.cacheMissInput !== null) nanos += priceTokens(usage.cacheMissInput, pricing.input);
  if (usage.cacheWriteInput !== null) {
    // Anthropic's cache write is 1.25x base input when not explicitly priced.
    nanos += priceTokens(usage.cacheWriteInput, pricing.cacheWrite ?? pricing.input * 1.25);
  }
  if (usage.outputTokens !== null) nanos += priceTokens(usage.outputTokens, pricing.output);
  if (usage.reasoningTokens !== null && pricing.reasoning !== null) {
    nanos += priceTokens(usage.reasoningTokens, pricing.reasoning);
  }
  return nanos;
}

/**
 * Combine child cost states into a parent's.
 *
 * Precedence is deliberately pessimistic and order-independent:
 *   0. nothing at all   → `incomplete`
 *   1. any `incomplete` → the total cannot be trusted as complete
 *   2. any `unpriced`   → part of the usage has no rate
 *   3. all `known`      → only if every component was provider-quoted
 *   4. otherwise        → `estimated`
 *
 * A mixture of provider-quoted and locally computed costs is `estimated`, not
 * `known`: the weakest component sets the confidence of the whole.
 *
 * The empty case is `incomplete` rather than `estimated` on purpose. Both would
 * carry 0 nanos, but `estimated` is a claim — "we worked out that this cost
 * nothing" — and an empty set supports no claim at all. This is the same
 * absence-vs-zero distinction that makes token counts nullable, applied to
 * confidence: a session with no ledger rows has an UNKNOWN cost, not a free one.
 */
export function aggregateCost(costs: readonly CostResult[]): CostResult {
  if (costs.length === 0) return { state: 'incomplete', nanos: 0, tokens: 0 };

  let nanos = 0;
  let tokens = 0;
  let anyIncomplete = false;
  let anyUnpriced = false;
  let allKnown = true;

  for (const c of costs) {
    nanos += c.nanos;
    tokens += c.tokens;
    if (c.state === 'incomplete') anyIncomplete = true;
    if (c.state === 'unpriced') anyUnpriced = true;
    if (c.state !== 'known') allKnown = false;
  }

  if (anyIncomplete) return { state: 'incomplete', nanos, tokens };
  if (anyUnpriced) return { state: 'unpriced', nanos, tokens };
  if (allKnown) return { state: 'known', nanos, tokens };
  return { state: 'estimated', nanos, tokens };
}

// ---------------------------------------------------------------------------
// Retry budget
// ---------------------------------------------------------------------------

/**
 * One shared retry allowance for an entire submitted prompt.
 *
 * Previously `maxRetries` was passed to `withRetry` on every model turn, so the
 * allowance reset each time: a 30-turn tool-using run could legitimately make
 * 30 × (1 + maxRetries) paid attempts. This object is created once per
 * AgentRun and never reset — a retry consumed while reading a file is gone by
 * the time the model is asked to summarise it.
 */
export class RetryBudget {
  readonly limit: number;
  private used = 0;

  constructor(limit: number) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  get consumed(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  canRetry(): boolean {
    return this.used < this.limit;
  }

  /** Take one unit. Returns false when the budget is already spent. */
  consume(): boolean {
    if (!this.canRetry()) return false;
    this.used += 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Attempt / request / run records
// ---------------------------------------------------------------------------

export type AttemptOutcome =
  | 'success'
  | 'retryable_error'
  | 'fatal_error'
  | 'cancelled'
  | 'not_dispatched';

export interface ProviderAttempt {
  runId: string;
  /** Which intended model turn this belongs to (1-based). */
  requestIndex: number;
  /** Which attempt within that request (1-based). */
  attemptIndex: number;
  /** 0 for the first attempt; 1.. for retries. */
  retryIndex: number;

  provider: string;
  requestedModel: string;
  /** What the provider said it actually used, when it reports it. */
  returnedModel: string | null;

  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;

  /** False when the failure happened before anything left the process. */
  dispatched: boolean;
  streamStarted: boolean;
  streamCompleted: boolean;

  outcome: AttemptOutcome;
  retryable: boolean | null;
  /** Short, bounded diagnostic. Never raw provider bodies or credentials. */
  errorCategory: string | null;
  errorMessage: string | null;
  retryDelayMs: number | null;

  usage: LedgerUsage;
  pricing: PricingSnapshot | null;
  cost: CostResult;
}

/** Cap on stored diagnostics — the ledger must never grow unbounded. */
const MAX_ERROR_CHARS = 200;

export function clampDiagnostic(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
}

export interface LogicalRequestSummary {
  requestIndex: number;
  attempts: number;
  retries: number;
  cost: CostResult;
}

export interface RunLedgerSummary {
  runId: string;
  modelKey: string | null;
  logicalRequests: number;
  providerAttempts: number;
  retriesUsed: number;
  retryLimit: number;
  cacheHitInput: TokenCount;
  cacheMissInput: TokenCount;
  outputTokens: TokenCount;
  reasoningTokens: TokenCount;
  cost: CostResult;
  finalized: boolean;
}

/**
 * The accounting for exactly one submitted prompt.
 *
 * Created fresh per AgentRun and never shared. Once `finalize()` runs the
 * record is frozen, so a late event from a superseded run cannot mutate totals
 * that have already been reported or persisted.
 */
export class RunLedger {
  readonly runId: string;
  readonly retryBudget: RetryBudget;

  private attempts: ProviderAttempt[] = [];
  private requestCount = 0;
  private currentRequest = 0;
  private attemptsThisRequest = 0;
  private frozen = false;
  private modelKey: string | null = null;

  constructor(runId: string, retryBudget: RetryBudget) {
    this.runId = runId;
    this.retryBudget = retryBudget;
  }

  get finalized(): boolean {
    return this.frozen;
  }

  /** Begin a new intended model turn. Tool results produce a NEW request. */
  beginRequest(): number {
    if (this.frozen) return this.currentRequest;
    this.requestCount += 1;
    this.currentRequest = this.requestCount;
    this.attemptsThisRequest = 0;
    return this.currentRequest;
  }

  /**
   * Record one outbound attempt. Called exactly once per attempt, including
   * failed, cancelled and never-dispatched ones.
   */
  recordAttempt(record: Omit<ProviderAttempt, 'runId' | 'requestIndex' | 'attemptIndex'>): void {
    if (this.frozen) return; // a finalized ledger is immutable
    if (this.currentRequest === 0) this.beginRequest();
    this.attemptsThisRequest += 1;
    if (record.requestedModel) this.modelKey = record.requestedModel;

    this.attempts.push({
      ...record,
      runId: this.runId,
      requestIndex: this.currentRequest,
      attemptIndex: this.attemptsThisRequest,
    });
  }

  /** Every attempt, in order. Copy — callers cannot mutate the ledger. */
  allAttempts(): readonly ProviderAttempt[] {
    return [...this.attempts];
  }

  requestSummaries(): LogicalRequestSummary[] {
    const byIndex = new Map<number, ProviderAttempt[]>();
    for (const a of this.attempts) {
      const list = byIndex.get(a.requestIndex) ?? [];
      list.push(a);
      byIndex.set(a.requestIndex, list);
    }
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([requestIndex, list]) => ({
        requestIndex,
        attempts: list.length,
        retries: list.filter((a) => a.retryIndex > 0).length,
        cost: aggregateCost(list.map((a) => a.cost)),
      }));
  }

  summary(): RunLedgerSummary {
    const costs = this.attempts.map((a) => a.cost);
    return {
      runId: this.runId,
      modelKey: this.modelKey,
      logicalRequests: this.requestCount,
      providerAttempts: this.attempts.length,
      retriesUsed: this.retryBudget.consumed,
      retryLimit: this.retryBudget.limit,
      cacheHitInput: sumTokens(this.attempts, (u) => u.cacheHitInput),
      cacheMissInput: sumTokens(this.attempts, (u) => u.cacheMissInput),
      outputTokens: sumTokens(this.attempts, (u) => u.outputTokens),
      reasoningTokens: sumTokens(this.attempts, (u) => u.reasoningTokens),
      cost: aggregateCost(costs),
      finalized: this.frozen,
    };
  }

  /**
   * Freeze the ledger. Idempotent: several terminal paths can race to finish a
   * run, and the first one to land is the one that counts.
   */
  finalize(): RunLedgerSummary {
    this.frozen = true;
    return this.summary();
  }
}

/**
 * Sum a token field across attempts.
 *
 * Returns null when NOTHING reported the field — summing unknowns into 0 is
 * exactly the lie this module exists to prevent. A single reported value makes
 * the sum meaningful, and the enclosing cost state still records that other
 * attempts were incomplete.
 */
function sumTokens(
  attempts: readonly ProviderAttempt[],
  pick: (u: LedgerUsage) => TokenCount,
): TokenCount {
  let total = 0;
  let sawAny = false;
  for (const a of attempts) {
    const v = pick(a.usage);
    if (v !== null) {
      total += v;
      sawAny = true;
    }
  }
  return sawAny ? total : null;
}

// ---------------------------------------------------------------------------
// Session aggregation
// ---------------------------------------------------------------------------

/**
 * Roll finalized run summaries into a session total.
 *
 * Deliberately derived from immutable per-run summaries rather than a mutable
 * running counter: a counter can double-count a run that finalizes twice, and
 * cannot be recomputed after the fact.
 */
export function aggregateSession(runs: readonly RunLedgerSummary[]): {
  runs: number;
  providerAttempts: number;
  retriesUsed: number;
  cost: CostResult;
} {
  const seen = new Set<string>();
  const unique: RunLedgerSummary[] = [];
  for (const r of runs) {
    if (seen.has(r.runId)) continue; // never count one run twice
    seen.add(r.runId);
    unique.push(r);
  }

  return {
    runs: unique.length,
    providerAttempts: unique.reduce((n, r) => n + r.providerAttempts, 0),
    retriesUsed: unique.reduce((n, r) => n + r.retriesUsed, 0),
    cost: aggregateCost(unique.map((r) => r.cost)),
  };
}
