/**
 * OpenAI ChatCompletions adapter.
 *
 * Covers DeepSeek, Z.ai (GLM), Moonshot (Kimi), Ollama, OpenRouter and OpenAI
 * itself. These providers cache prompt prefixes automatically — there is
 * nothing to opt into, we just have to not break the prefix (see
 * agent/messages.ts). So `cacheHints` is ignored here by design.
 */

import OpenAI from 'openai';
import { stableStringify } from '../util/stable-json.ts';
import { classifyHttpError } from './retry.ts';
import { UNKNOWN_USAGE, buildUsage, type LedgerUsage } from '../session/ledger.ts';
import {
  AbortedError,
  ProviderError,
  ZERO_USAGE,
  type Message,
  type NormalizedUsage,
  type Provider,
  type ProviderRequest,
  type StopReason,
  type StreamEvent,
  type ToolSchema,
} from './types.ts';

export class OpenAIProvider implements Provider {
  readonly kind = 'openai' as const;
  readonly name: string;
  private client: OpenAI;

  constructor(
    name: string,
    opts: { apiKey: string; baseURL?: string; headers?: Record<string, string> },
  ) {
    this.name = name;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.headers,
      // We do our own retries (retry.ts) so the policy is uniform across both
      // adapters and observable in the UI.
      maxRetries: 0,
    });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const body: Record<string, unknown> = {
      model: req.entry.model,
      messages: toChatMessages(req.system, req.messages),
      max_tokens: req.maxTokens,
      stream: true,
    };

    if (req.tools.length > 0) {
      body.tools = toChatTools(req.tools);
    }
    // Usage is not included in a stream unless you ask. Without this the cost
    // report is empty — which would hide exactly the number this tool exists to
    // show. Ollama's OpenAI shim historically rejects it, so skip it locally.
    if (!req.entry.local) {
      body.stream_options = { include_usage: true };
    }

    let stream: AsyncIterable<ChatChunk>;
    try {
      stream = (await this.client.chat.completions.create(body as never, {
        signal: req.signal,
      })) as unknown as AsyncIterable<ChatChunk>;
    } catch (err) {
      if (req.signal.aborted) throw new AbortedError();
      throw classifyHttpError(err, this.name);
    }

    // Tool calls arrive as fragments keyed by `index`; we announce each index
    // once on first sight, then forward argument deltas as they stream.
    const announced = new Set<number>();
    let usage: NormalizedUsage = ZERO_USAGE;
    let rawUsage: OpenAIUsage | undefined;
    // Deliberately NOT seeded with 'end_turn'. A stream that closes without a
    // finish_reason must be reported as incomplete, not as a clean stop —
    // pre-seeding it made a truncated response look like a finished answer.
    let stopReason: StopReason = 'other';
    let sawFinishReason = false;
    let rawFinishReason: string | undefined;
    let sawAnyToolCall = false;

    try {
      for await (const chunk of stream) {
        if (req.signal.aborted) throw new AbortedError();

        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage);
          rawUsage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        // DeepSeek exposes thinking as `reasoning_content`; OpenRouter uses
        // `reasoning`. Both are display-only — never echoed back in history.
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          yield { type: 'reasoning_delta', text: reasoning };
        }

        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index ?? 0;
          if (!announced.has(index)) {
            announced.add(index);
            sawAnyToolCall = true;
            yield {
              type: 'tool_call_start',
              index,
              // Some providers omit the id on the first fragment. A synthesized
              // id is fine as long as it is stable within the turn.
              id: tc.id ?? `call_${index}`,
              name: tc.function?.name ?? '',
            };
          }
          if (tc.function?.arguments) {
            yield { type: 'tool_args_delta', index, delta: tc.function.arguments };
          }
        }

        if (choice.finish_reason) {
          sawFinishReason = true;
          rawFinishReason = choice.finish_reason;
          stopReason = mapFinishReason(choice.finish_reason, sawAnyToolCall);
        }
      }
    } catch (err) {
      // Usage the provider already sent is real and must survive the failure.
      // Yielding it here rather than swallowing it is what lets a run that died
      // mid-stream report "at least this much" instead of nothing. The consumer
      // pulls this event, then the next pull rethrows — so the error is not
      // suppressed, and because the success path below is unreachable once we
      // throw, the same usage can never be emitted twice.
      if (rawUsage) yield { type: 'usage', usage, detail: ledgerUsageFromOpenAI(rawUsage) };
      if (err instanceof AbortedError || req.signal.aborted) throw new AbortedError();
      if (err instanceof ProviderError) throw err;
      throw classifyHttpError(err, this.name);
    }

    yield { type: 'usage', usage, detail: rawUsage ? ledgerUsageFromOpenAI(rawUsage) : UNKNOWN_USAGE };
    yield { type: 'done', stopReason, explicit: sawFinishReason, raw: rawFinishReason };
  }
}

// ---------------------------------------------------------------------------
// Conversion: internal block format -> ChatCompletions
// ---------------------------------------------------------------------------

interface ChatChunk {
  usage?: OpenAIUsage;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

function toChatTools(tools: ToolSchema[]): unknown[] {
  // Sorted by name so the serialized tool block is byte-identical every turn.
  // Tools render at the very front of the prompt, so any reordering here
  // invalidates the entire cache for the whole session.
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

/**
 * Flatten block-structured messages into ChatCompletions' flat list.
 *
 * The one non-obvious rule: `tool_result` blocks must become standalone
 * `role:"tool"` messages placed immediately after the assistant turn that
 * requested them, in the same order. Getting the order wrong produces a
 * confusing 400 from most providers ("tool_call_id not found").
 */
export function toChatMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = msg.content.filter(
        (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      const assistant: Record<string, unknown> = { role: 'assistant' };
      // `content` must be null (not "") when there are only tool calls; some
      // providers reject an empty string alongside tool_calls.
      assistant.content = text.length > 0 ? text : null;
      if (toolUses.length > 0) {
        assistant.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: stableStringify(tu.input) },
        }));
      }
      out.push(assistant);
      continue;
    }

    // User turn: tool results first (answering the assistant's calls), then any
    // human text as a separate user message.
    const results = msg.content.filter(
      (b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    for (const r of results) {
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        // ChatCompletions has no is_error flag, so the marker goes inline —
        // models reliably pick up on it and self-correct.
        content: r.is_error ? `ERROR: ${r.content}` : r.content,
      });
    }

    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text.length > 0) out.push({ role: 'user', content: text });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek's dialect. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** The OpenAI-standard dialect, used by GLM / Kimi / OpenRouter. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek/OpenAI reasoning breakdown, when the model produces one. */
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Two vocabularies for the same thing.
 *
 * DeepSeek reports hit/miss as a partition of the prompt. Everyone else reports
 * a total plus a cached subset. We normalize to "uncached remainder + cached",
 * so `inputTokens` never double-counts cached tokens — the mistake that makes a
 * cost report understate spend.
 */
export function normalizeOpenAIUsage(usage: OpenAIUsage): NormalizedUsage {
  const output = usage.completion_tokens ?? 0;

  if (typeof usage.prompt_cache_hit_tokens === 'number') {
    return {
      cachedInputTokens: usage.prompt_cache_hit_tokens,
      inputTokens:
        usage.prompt_cache_miss_tokens ??
        Math.max(0, (usage.prompt_tokens ?? 0) - usage.prompt_cache_hit_tokens),
      cacheWriteTokens: 0,
      outputTokens: output,
    };
  }

  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    cachedInputTokens: cached,
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    cacheWriteTokens: 0,
    outputTokens: output,
  };
}

function mapFinishReason(reason: string, sawToolCall: boolean): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      // Some providers report "stop" even when they emitted tool calls.
      return sawToolCall ? 'tool_use' : 'end_turn';
    default:
      return 'other';
  }
}

/**
 * Ledger view of an OpenAI-shaped usage object.
 *
 * Two dialects, and the difference matters for honesty:
 *   DeepSeek   reports hit AND miss explicitly — both count as "reported".
 *   OpenAI-ish reports a total plus a cached subset, so miss is "derived".
 *
 * Anything the provider omits stays null. In particular `reasoning_tokens` is
 * only present on models that actually produce reasoning, and its absence must
 * never become a zero.
 */
export function ledgerUsageFromOpenAI(u: OpenAIUsage): LedgerUsage {
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null;
  return buildUsage({
    cacheHitInput: hit,
    // Only DeepSeek states the miss directly; otherwise buildUsage derives it
    // from total - hit, and marks it derived.
    cacheMissInput: u.prompt_cache_miss_tokens ?? null,
    totalInput: u.prompt_tokens ?? null,
    outputTokens: u.completion_tokens ?? null,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
  });
}
