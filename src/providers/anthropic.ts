/**
 * Anthropic Messages adapter.
 *
 * Despite the name this is NOT Anthropic-only. Three providers use it:
 *   - Anthropic proper (the opt-in "strong" tier)
 *   - Z.ai's GLM Coding Plan  (https://api.z.ai/api/anthropic) — a flat monthly
 *     subscription, so marginal token cost is zero
 *   - DeepSeek's Messages-format endpoint
 *
 * The meaningful difference from the OpenAI adapter is caching. Anthropic does
 * not cache automatically: you must place `cache_control` breakpoints yourself,
 * you get at most 4 per request, and a prefix below the model's minimum
 * (512 tokens on Opus 5, 1024 on Sonnet 5, 4096 on Haiku 4.5) silently doesn't
 * cache at all. agent/messages.ts decides placement; we just apply it.
 *
 * Request shape is kept deliberately minimal — model, max_tokens, system,
 * messages, tools, stream. No temperature/top_p (removed on current Anthropic
 * models: sending them is a 400) and no `thinking` config (models pick a sane
 * default, and Fable 5 rejects an explicit disable). Minimal also means maximum
 * portability across the three vendors above.
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildUsage, type LedgerUsage } from '../session/ledger.ts';
import { classifyHttpError } from './retry.ts';
import {
  AbortedError,
  ProviderError,
  ZERO_USAGE,
  type CacheHints,
  type Message,
  type NormalizedUsage,
  type Provider,
  type ProviderRequest,
  type StopReason,
  type StreamEvent,
  type ToolSchema,
} from './types.ts';

export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  readonly name: string;
  private client: Anthropic;

  constructor(
    name: string,
    opts: { apiKey: string; baseURL?: string; headers?: Record<string, string> },
  ) {
    this.name = name;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.headers,
      maxRetries: 0, // retry.ts owns retry policy for both adapters
    });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const useCacheControl = !req.entry.autoCache;

    const body: Record<string, unknown> = {
      model: req.entry.model,
      max_tokens: req.maxTokens,
      system: toSystemBlocks(req.system, useCacheControl && req.cacheHints.cacheSystem),
      messages: toAnthropicMessages(
        req.messages,
        useCacheControl ? req.cacheHints.cacheMessageIndex : null,
      ),
      stream: true,
    };
    if (req.tools.length > 0) body.tools = toAnthropicTools(req.tools);

    let stream: AsyncIterable<AnthropicEvent>;
    try {
      stream = (await this.client.messages.create(body as never, {
        signal: req.signal,
      })) as unknown as AsyncIterable<AnthropicEvent>;
    } catch (err) {
      if (req.signal.aborted) throw new AbortedError();
      throw classifyHttpError(err, this.name);
    }

    // Anthropic reports input usage up front (message_start) and output usage at
    // the end (message_delta), so we accumulate rather than overwrite.
    let usage: NormalizedUsage = { ...ZERO_USAGE };
    // Not seeded with 'end_turn' — see the note in openai.ts. A stream with no
    // stop_reason is an incomplete response, not a successful one.
    let stopReason: StopReason = 'other';
    let sawStopReason = false;
    /** Whether the provider has reported any usage yet — see the catch below. */
    let sawUsage = false;
    let rawStopReason: string | undefined;
    /** content block index -> tool call index, since not every block is a tool. */
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;

    try {
      for await (const event of stream) {
        if (req.signal.aborted) throw new AbortedError();

        switch (event.type) {
          case 'message_start': {
            const u = event.message?.usage;
            if (u) {
              sawUsage = true;
              usage.inputTokens = u.input_tokens ?? 0;
              usage.cachedInputTokens = u.cache_read_input_tokens ?? 0;
              usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
              usage.outputTokens = u.output_tokens ?? 0;
            }
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
              const toolIndex = nextToolIndex++;
              toolIndexByBlock.set(event.index ?? 0, toolIndex);
              yield {
                type: 'tool_call_start',
                index: toolIndex,
                id: block.id ?? `call_${toolIndex}`,
                name: block.name ?? '',
              };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (!delta) break;
            if (delta.type === 'text_delta' && delta.text) {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'reasoning_delta', text: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              const toolIndex = toolIndexByBlock.get(event.index ?? 0);
              if (toolIndex !== undefined && delta.partial_json) {
                yield { type: 'tool_args_delta', index: toolIndex, delta: delta.partial_json };
              }
            }
            break;
          }

          case 'message_delta': {
            if (event.usage?.output_tokens !== undefined) {
              usage.outputTokens = event.usage.output_tokens;
            }
            if (event.delta?.stop_reason) {
              sawStopReason = true;
              rawStopReason = event.delta.stop_reason;
              stopReason = mapStopReason(event.delta.stop_reason);
            }
            break;
          }
        }
      }
    } catch (err) {
      // Anthropic reports input usage up front in `message_start`, so a stream
      // that dies later has usually already told us most of what it consumed.
      // Surfacing it before rethrowing turns a lost figure into an honest lower
      // bound. Unreachable from the success path, so nothing is emitted twice.
      if (sawUsage) yield { type: 'usage', usage, detail: ledgerUsageFromAnthropic(usage) };
      if (err instanceof AbortedError || req.signal.aborted) throw new AbortedError();
      if (err instanceof ProviderError) throw err;
      throw classifyHttpError(err, this.name);
    }

    yield { type: 'usage', usage, detail: ledgerUsageFromAnthropic(usage) };
    yield { type: 'done', stopReason, explicit: sawStopReason, raw: rawStopReason };
  }
}

/**
 * Ledger view of accumulated Anthropic usage.
 *
 * Anthropic reports the three input buckets directly and they do not overlap,
 * so total input is their sum and cache-miss is the plain `input_tokens` field.
 * Extracted so the mid-stream failure path and the clean path build it
 * identically — two spellings of the same mapping would be a bug waiting to
 * diverge.
 */
function ledgerUsageFromAnthropic(usage: NormalizedUsage): LedgerUsage {
  return buildUsage({
    cacheHitInput: usage.cachedInputTokens,
    cacheMissInput: usage.inputTokens,
    cacheWriteInput: usage.cacheWriteTokens,
    totalInput: usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    // Anthropic does not break out reasoning tokens separately.
    reasoningTokens: null,
  });
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * The system prompt as a block array so we can attach a cache breakpoint.
 *
 * Render order is tools -> system -> messages, so a breakpoint here also caches
 * the tool definitions. That is why the tool block never needs its own marker —
 * which matters, given the hard limit of 4 breakpoints per request.
 */
function toSystemBlocks(system: string, cache: boolean): unknown {
  if (!system) return undefined;
  const block: Record<string, unknown> = { type: 'text', text: system };
  if (cache) block.cache_control = { type: 'ephemeral' };
  return [block];
}

function toAnthropicTools(tools: ToolSchema[]): unknown[] {
  // Sorted for byte-stability: tools sit at position 0 of the prompt, so any
  // reordering invalidates the cache for the entire session.
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/**
 * Map internal blocks 1:1 (this format was modeled on Anthropic's), attaching a
 * rolling cache breakpoint to the last content block of `cacheIndex`.
 */
export function toAnthropicMessages(messages: Message[], cacheIndex: number | null): unknown[] {
  return messages.map((msg, i) => {
    const blocks = msg.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error ? { is_error: true } : {}),
          };
      }
    }) as Array<Record<string, unknown>>;

    if (i === cacheIndex && blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last) last.cache_control = { type: 'ephemeral' };
    }
    return { role: msg.role, content: blocks };
  });
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------
// Minimal structural types for the raw event stream.
// ---------------------------------------------------------------------------

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
}
