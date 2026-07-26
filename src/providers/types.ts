import type { LedgerUsage } from '../session/ledger.ts';
/**
 * The provider abstraction.
 *
 * Forge speaks exactly two wire formats — OpenAI ChatCompletions and Anthropic
 * Messages — and every provider we care about speaks at least one of them:
 *
 *   ChatCompletions : DeepSeek, Z.ai (GLM), Moonshot (Kimi), Ollama,
 *                     OpenRouter, OpenAI
 *   Messages        : Anthropic, DeepSeek (alternate endpoint),
 *                     Z.ai GLM Coding Plan
 *
 * Both adapters normalize down to the `StreamEvent` union below, so the agent
 * loop never branches on provider. Adding a provider is usually a config entry,
 * not code.
 *
 * INTERNAL MESSAGE FORMAT
 * We model messages as Anthropic-style content blocks rather than OpenAI's
 * shape. That direction is lossless: a block list converts cleanly *down* to
 * ChatCompletions (tool results become separate `role:"tool"` messages), while
 * the reverse loses the grouping of parallel tool results into one turn — and
 * that grouping matters, because splitting tool results across messages teaches
 * models to stop making parallel calls.
 */

import type { ModelEntry } from '../config/schema.ts';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/**
 * Where to place Anthropic `cache_control` breakpoints.
 *
 * Providers with `autoCache` ignore this entirely — they cache any repeated
 * prefix with no client cooperation. Anthropic requires explicit markers and
 * allows at most 4 per request, which is why this is computed centrally in
 * agent/messages.ts rather than guessed at by the adapter.
 */
export interface CacheHints {
  /** Mark the end of the system block (this also caches the tool definitions). */
  cacheSystem: boolean;
  /** Index into `messages` to mark, or null. Rolls forward as the chat grows. */
  cacheMessageIndex: number | null;
}

export interface ProviderRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  entry: ModelEntry;
  maxTokens: number;
  signal: AbortSignal;
  cacheHints: CacheHints;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'other';

export type StreamEvent =
  /** Visible assistant text. */
  | { type: 'text_delta'; text: string }
  /** Chain-of-thought / reasoning text, rendered dimmed and never sent back. */
  | { type: 'reasoning_delta'; text: string }
  /** A tool call has begun. `index` disambiguates parallel calls. */
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  /** Raw JSON fragment for the tool at `index`. Accumulate, then repair+parse. */
  | { type: 'tool_args_delta'; index: number; delta: string }
  /**
   * Token accounting. May arrive more than once; the loop takes the max.
   *
   * `usage` stays as-is for the existing cost display. `detail` is the Step 4B
   * ledger view: same numbers, but nullable, so "the provider did not report
   * output tokens" is distinguishable from "the provider reported zero".
   * Optional so an adapter that has not been updated simply contributes no
   * ledger detail rather than silently contributing zeros.
   */
  | { type: 'usage'; usage: NormalizedUsage; detail?: LedgerUsage }
  /**
   * Terminal event. Always emitted exactly once unless the stream throws.
   *
   * `explicit` distinguishes "the provider told us why it stopped" from "the
   * stream just ended". Without it a silently truncated response is
   * indistinguishable from a clean finish, and the agent reports success on a
   * half-written answer. Adapters must set it to false when no terminal signal
   * arrived; `stopReason` is then meaningless and must not be trusted.
   *
   * `raw` preserves the provider's own wording for anything we could not
   * normalize, so an unknown reason can be reported instead of guessed.
   */
  | { type: 'done'; stopReason: StopReason; explicit: boolean; raw?: string };

/**
 * Token usage, normalized across three different provider vocabularies.
 *
 *   DeepSeek   prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   OpenAI-ish prompt_tokens_details.cached_tokens
 *   Anthropic  cache_read_input_tokens / cache_creation_input_tokens
 *
 * `inputTokens` is always the *uncached* remainder, so total prompt size is
 * inputTokens + cachedInputTokens + cacheWriteTokens. Getting this wrong makes
 * the cost report lie in the flattering direction, so it is unit-tested.
 */
export interface NormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  /** Anthropic only; other providers populate the cache for free. */
  cacheWriteTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export interface Provider {
  /** Provider key from config, e.g. "deepseek". Used in errors and the UI. */
  readonly name: string;
  /** Wire format actually in use. */
  readonly kind: 'openai' | 'anthropic';
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A provider failure with enough structure for the UI to render something
 * actionable instead of a stack trace, and for retry.ts to decide.
 */
export interface ProviderErrorOptions {
  provider: string;
  status?: number;
  retryable: boolean;
  /** Seconds the provider asked us to wait, from a Retry-After header. */
  retryAfter?: number;
  hint?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  // Declared explicitly rather than as a constructor parameter property:
  // Node's built-in type stripping (which lets `node --test` run .ts files with
  // no build step) rejects parameter properties.
  readonly opts: ProviderErrorOptions;

  constructor(message: string, opts: ProviderErrorOptions) {
    super(message);
    this.name = 'ProviderError';
    this.opts = opts;
  }
}

/** User pressed Ctrl-C. Not an error condition — unwound quietly by the loop. */
export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}
