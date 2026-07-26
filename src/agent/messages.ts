/**
 * Conversation state and cache-stable request assembly.
 *
 * ============================================================================
 * READ THIS FIRST — it is the reason forge is cheap.
 * ============================================================================
 *
 * An agent loop resends the entire conversation on every turn. A task with 20
 * tool calls sends the transcript 20 times. So the cost of a session is not
 * really "tokens x price" — it is "tokens x price x turns", and the only lever
 * that moves it by an order of magnitude is the provider's prompt cache.
 *
 * The numbers (per 1M input tokens, verified 2026-07-25):
 *
 *      DeepSeek V4 Flash    $0.14   uncached   ->  $0.0028  cached   (50x)
 *      DeepSeek V4 Pro      $0.435  uncached   ->  $0.0036  cached  (120x)
 *      Kimi K2.5            $0.60   uncached   ->  $0.10    cached    (6x)
 *      GLM-4.7              $0.40   uncached   ->  $0.11    cached    (4x)
 *      Claude Opus 5        $5.00   uncached   ->  $0.50    cached   (10x)
 *
 * Every one of those caches is a PREFIX BYTE MATCH. Not a semantic match — a
 * literal comparison of the serialized request from position 0. One byte
 * changes near the front and everything after it is billed at full price.
 *
 * The cheap providers (DeepSeek, GLM, Kimi) cache automatically: there is
 * nothing to opt into and nothing to configure. They ask only one thing of us —
 * *don't change the prefix*. That makes this file, not the model picker, the
 * highest-leverage code in the project.
 *
 * Hence the layout below, ordered strictly by volatility:
 *
 *     [ system prompt   ]  frozen at session start        <- never changes
 *     [ tool schemas    ]  sorted, deterministically serialized
 *       <- cache breakpoint (Anthropic only; others cache this implicitly)
 *     [ conversation    ]  append-only
 *       <- rolling breakpoint on the newest turn
 *
 * THE RULES, and what breaks if you ignore them:
 *
 *  1. Never interpolate a clock, counter, or mutable state into the system
 *     prompt. `new Date()` in there costs 50x on DeepSeek, silently, forever.
 *     prompt.ts captures anything time-like once, at startup.
 *
 *  2. Tools are fixed for the session. Tool schemas render at position 0, so
 *     registering a tool mid-session invalidates the whole session's cache.
 *     If tools must change, start a new session.
 *
 *  3. Serialization must be deterministic — hence stableStringify and the
 *     sort-by-name in both adapters. A tool call replayed from SQLite must
 *     produce the same bytes as the same call held in memory, or `--resume`
 *     silently costs full price.
 *
 *  4. Append only. Rewriting history (see truncate.ts) resets the cache, so it
 *     happens rarely and in one batch rather than incrementally.
 *
 *  5. Caches are model-scoped. `/model strong` starts a fresh lineage; the UI
 *     says so rather than letting the user wonder where their hit rate went.
 *
 * These invariants are enforced by a test (messages.test.ts) that assembles the
 * prefix across simulated turns and asserts the bytes are identical.
 */

import { createHash } from 'node:crypto';
import { stableStringify } from '../util/stable-json.ts';
import type { ModelEntry } from '../config/schema.ts';
import type {
  CacheHints,
  ContentBlock,
  Message,
  ProviderRequest,
  ToolSchema,
} from '../providers/types.ts';
import { estimateTokens } from './truncate.ts';

/**
 * How often the mid-transcript "anchor" breakpoint advances, in messages.
 *
 * Anthropic walks back at most 20 content blocks from a breakpoint looking for
 * an existing cache entry. An agent turn with many parallel tool calls can blow
 * past 20 blocks in one go, at which point the rolling breakpoint finds nothing
 * and silently misses. A second, slow-moving breakpoint gives it a nearby
 * anchor to land on. It advances in strides so it stays byte-stable for several
 * turns at a time instead of moving (and re-writing cache) every request.
 */
const ANCHOR_STRIDE = 8;

export interface ConversationOptions {
  system: string;
  tools: ToolSchema[];
}

export class Conversation {
  readonly system: string;
  readonly tools: ToolSchema[];
  private _messages: Message[] = [];

  /**
   * The model key the current cache lineage belongs to. Switching models
   * abandons the cache — tracked so the UI can explain a sudden 0% hit rate
   * rather than leaving the user to wonder.
   */
  private cacheLineageModel: string | null = null;

  constructor(opts: ConversationOptions) {
    this.system = opts.system;
    // Sorted once, here, so every later serialization is identical by
    // construction rather than by the discipline of each call site.
    this.tools = [...opts.tools].sort((a, b) => a.name.localeCompare(b.name));
  }

  get messages(): readonly Message[] {
    return this._messages;
  }

  get length(): number {
    return this._messages.length;
  }

  /** Replace the transcript wholesale — used by --resume and the context guard. */
  setMessages(messages: Message[]): void {
    this._messages = messages;
  }

  addUserText(text: string): void {
    this._messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  addAssistant(content: ContentBlock[]): void {
    if (content.length === 0) return;
    this._messages.push({ role: 'assistant', content });
  }

  /**
   * Append all results from one assistant turn as a SINGLE user message.
   *
   * This grouping is load-bearing, not cosmetic. Splitting parallel tool
   * results across multiple messages trains the model to stop issuing parallel
   * calls, which makes every subsequent task slower and more expensive.
   */
  addToolResults(results: ContentBlock[]): void {
    if (results.length === 0) return;
    this._messages.push({ role: 'user', content: results });
  }

  // -------------------------------------------------------------------------
  // Request assembly
  // -------------------------------------------------------------------------

  buildRequest(entry: ModelEntry, maxTokens: number, signal: AbortSignal): ProviderRequest {
    return {
      system: this.system,
      // Snapshot rather than share the live array. A request represents the
      // transcript at one instant; handing out a live reference means a request
      // object silently changes meaning as the conversation continues, which
      // makes both retries and cache reasoning unsound.
      messages: [...this._messages],
      tools: this.tools,
      entry,
      maxTokens,
      signal,
      cacheHints: this.computeCacheHints(entry),
    };
  }

  /**
   * Decide where Anthropic `cache_control` markers go.
   *
   * Providers with `autoCache` get an empty result: they need no markers, and
   * sending them to a non-Anthropic endpoint risks a 400 for an unknown field.
   *
   * Anthropic allows at most 4 breakpoints. We spend at most 3:
   *   1. end of system   — also covers tools, since render order is
   *                        tools -> system -> messages
   *   2. anchor          — slow-moving mid-transcript fallback (see ANCHOR_STRIDE)
   *   3. newest turn     — rolling; writes the delta so the next turn reads it
   * The 4th is left unspent as headroom.
   */
  private computeCacheHints(entry: ModelEntry): CacheHints {
    if (entry.autoCache) {
      return { cacheSystem: false, cacheMessageIndex: null };
    }

    // Below the model's minimum cacheable prefix, a breakpoint does nothing at
    // all — no error, no cache, just a silently wasted marker. Opus 5 needs 512
    // tokens, Sonnet 5 needs 1024, Haiku 4.5 needs 4096.
    const minCacheable = entry.minCacheable ?? 1024;
    const prefixTokens = estimateTokens(this.system) + estimateTokens(stableStringify(this.tools));
    const cacheSystem = prefixTokens >= minCacheable;

    // Only worth a rolling breakpoint once there is history to reuse.
    const cacheMessageIndex = this._messages.length >= 2 ? this._messages.length - 1 : null;

    return { cacheSystem, cacheMessageIndex };
  }

  /** The anchor breakpoint index, or null when the transcript is still short. */
  anchorIndex(): number | null {
    if (this._messages.length < ANCHOR_STRIDE * 2) return null;
    const last = this._messages.length - 1;
    return Math.floor(last / ANCHOR_STRIDE) * ANCHOR_STRIDE - ANCHOR_STRIDE;
  }

  // -------------------------------------------------------------------------
  // Cache diagnostics
  // -------------------------------------------------------------------------

  /**
   * A hash of the immutable prefix (system + tools).
   *
   * Two uses:
   *   - the byte-stability regression test asserts this never changes mid-session
   *   - `/cost` can flag "prefix changed this session", which is the one
   *     explanation for a hit rate that collapses without an obvious cause
   */
  prefixFingerprint(): string {
    const canonical = stableStringify({ system: this.system, tools: this.tools });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /**
   * Record which model the cache belongs to.
   * Returns true when the lineage was broken by this call (i.e. the model
   * changed), so the caller can tell the user their cache just reset.
   */
  noteModel(modelKey: string): boolean {
    const broken = this.cacheLineageModel !== null && this.cacheLineageModel !== modelKey;
    this.cacheLineageModel = modelKey;
    return broken;
  }
}
