/**
 * Context budget management (the M1 half — no LLM calls involved).
 *
 * Two mechanisms:
 *
 *   1. PER-RESULT TRUNCATION. A single tool result is capped before it ever
 *      enters the transcript. This is pure win: a 40k-line grep dump helps
 *      nobody and costs real money on every subsequent turn.
 *
 *   2. THE CONTEXT GUARD. When the transcript approaches the model's window we
 *      replace old tool results with short stubs.
 *
 * A NOTE ON MECHANISM 2 AND CACHING — this is the interesting tradeoff.
 * Rewriting history changes the cached prefix, so the very next request is a
 * full cache miss. That is expensive, so the guard is deliberately:
 *
 *   - late      (only at ~90% of the window; most sessions never reach it)
 *   - batched   (one big trim down to ~50%, not a nibble every turn — paying the
 *               cache reset once instead of on every request)
 *   - tail-safe (recent turns are never touched, so the model keeps its
 *               working context)
 *
 * Real summarizing compaction — which preserves meaning rather than discarding
 * it — is Milestone 2. This is the cheap guard that keeps M1 usable without it.
 */

import type { ContentBlock, Message } from '../providers/types.ts';

/** Turns at the end of the transcript that the guard will never rewrite. */
const PROTECTED_RECENT_MESSAGES = 6;

/** After trimming, aim to be back down at this share of the window. */
const TRIM_TARGET_PCT = 0.5;

/**
 * Rough token estimate: ~3.6 characters per token.
 *
 * Deliberately dependency-free. Real tokenizers differ per provider (and the
 * providers we target don't publish one), so an exact count would be false
 * precision. This is used only for budget decisions where being 15% off is
 * harmless; actual billed tokens always come from the provider's usage field.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(message: Message): number {
  let total = 4; // per-message framing overhead
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        total += estimateTokens(block.text);
        break;
      case 'tool_use':
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input)) + 8;
        break;
      case 'tool_result':
        total += estimateTokens(block.content) + 8;
        break;
    }
  }
  return total;
}

export function estimateTranscriptTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// 1. Per-result truncation
// ---------------------------------------------------------------------------

export interface TruncationResult {
  content: string;
  truncated: boolean;
}

/**
 * Cap a tool result, keeping the head and the tail.
 *
 * Both ends matter: the head has the structure (a file's imports, a command's
 * banner) and the tail has the conclusion (the error, the summary line, the
 * exit status). Cutting only the tail throws away the part that usually answers
 * the question.
 */
export function truncateToolOutput(content: string, maxBytes: number): TruncationResult {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return { content, truncated: false };
  }

  const headBytes = Math.floor(maxBytes * 0.65);
  const tailBytes = maxBytes - headBytes;

  const buf = Buffer.from(content, 'utf8');
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8');

  const omitted = buf.length - headBytes - tailBytes;
  const notice = `\n\n... [forge truncated ${omitted.toLocaleString()} bytes from the middle. Narrow the request — use read_file with offset/limit, or a more specific grep pattern — to see the elided region.] ...\n\n`;

  return { content: head + notice + tail, truncated: true };
}

// ---------------------------------------------------------------------------
// 2. The context guard
// ---------------------------------------------------------------------------

export type ContextPressure = 'ok' | 'warn' | 'trim';

export interface ContextStatus {
  pressure: ContextPressure;
  estimatedTokens: number;
  contextWindow: number;
  /** 0..1 — what fraction of the window the transcript currently occupies. */
  ratio: number;
}

export function assessContext(
  messages: Message[],
  systemPromptTokens: number,
  contextWindow: number,
  warnPct: number,
  trimPct: number,
): ContextStatus {
  const estimatedTokens = estimateTranscriptTokens(messages) + systemPromptTokens;
  const ratio = estimatedTokens / contextWindow;
  const pressure: ContextPressure = ratio >= trimPct ? 'trim' : ratio >= warnPct ? 'warn' : 'ok';
  return { pressure, estimatedTokens, contextWindow, ratio };
}

export interface TrimReport {
  messages: Message[];
  /** How many tool results were replaced with stubs. */
  elided: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Elide old tool results, oldest first, until the transcript fits the target.
 *
 * Ordering is deliberate. We elide in two passes:
 *
 *   Pass 1 — results that are already *superseded*: a read_file of a path that a
 *            later edit_file/write_file has since changed. That content is not
 *            merely old, it is actively misleading, and dropping it costs
 *            nothing in capability.
 *   Pass 2 — plain oldest-first, if pass 1 didn't free enough.
 *
 * The tool_use block that produced each result is always kept, so the model can
 * still see *that* it read a file and can re-read if it needs to.
 */
export function trimTranscript(
  messages: Message[],
  systemPromptTokens: number,
  contextWindow: number,
): TrimReport {
  const tokensBefore = estimateTranscriptTokens(messages) + systemPromptTokens;
  const target = Math.floor(contextWindow * TRIM_TARGET_PCT);

  // Deep-copy only the blocks we may mutate; message objects are shared elsewhere.
  const working: Message[] = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const lastProtectedIndex = working.length - PROTECTED_RECENT_MESSAGES;

  const superseded = findSupersededReads(working);
  let elided = 0;
  let current = tokensBefore;

  const elide = (msgIndex: number, blockIndex: number, reason: string): void => {
    const message = working[msgIndex];
    if (!message) return;
    const block = message.content[blockIndex];
    if (!block || block.type !== 'tool_result') return;
    if (block.content.startsWith('[elided')) return;

    const before = estimateTokens(block.content);
    const stub: ContentBlock = {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: `[elided by forge to reclaim context — ${reason}. Re-run the tool if you need this again.]`,
      ...(block.is_error ? { is_error: true } : {}),
    };
    message.content[blockIndex] = stub;
    current -= before - estimateTokens(stub.content);
    elided++;
  };

  // Pass 1: superseded reads.
  for (const { messageIndex, blockIndex } of superseded) {
    if (current <= target) break;
    if (messageIndex >= lastProtectedIndex) continue;
    elide(messageIndex, blockIndex, 'this file was modified after it was read');
  }

  // Pass 2: oldest first.
  for (let i = 0; i < lastProtectedIndex && current > target; i++) {
    const message = working[i];
    if (!message) continue;
    for (let j = 0; j < message.content.length && current > target; j++) {
      if (message.content[j]?.type === 'tool_result') {
        elide(i, j, 'older than the active working set');
      }
    }
  }

  return { messages: working, elided, tokensBefore, tokensAfter: current };
}

/** Locate read_file results whose file a later write/edit has invalidated. */
function findSupersededReads(
  messages: Message[],
): Array<{ messageIndex: number; blockIndex: number }> {
  /** tool_use_id -> the path a read_file call targeted. */
  const readPathById = new Map<string, string>();
  /** path -> index of the message containing the last mutation of that path. */
  const lastMutation = new Map<string, number>();

  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const path = typeof block.input.path === 'string' ? block.input.path : undefined;
      if (!path) continue;

      if (block.name === 'read_file') {
        readPathById.set(block.id, path);
      } else if (block.name === 'write_file' || block.name === 'edit_file' || block.name === 'multi_edit') {
        lastMutation.set(path, index);
      }
    }
  });

  const out: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type !== 'tool_result') return;
      const path = readPathById.get(block.tool_use_id);
      if (!path) return;
      const mutatedAt = lastMutation.get(path);
      if (mutatedAt !== undefined && mutatedAt > messageIndex) {
        out.push({ messageIndex, blockIndex });
      }
    });
  });
  return out;
}
