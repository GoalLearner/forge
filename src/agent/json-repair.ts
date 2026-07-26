/**
 * Tolerant parsing of model-produced tool arguments.
 *
 * WHY THIS FILE EXISTS
 * Frontier models emit clean JSON for tool calls. Cheap models do not — and
 * this is the single biggest source of "the agent broke" when you drop from
 * Claude to GLM/Kimi/DeepSeek. Observed failure modes, all handled below:
 *
 *   1. The payload wrapped in a ```json fence
 *   2. Prose before or after the object ("Here's the call: {...}")
 *   3. Trailing commas         {"a": 1,}
 *   4. Python literals         {"ok": True, "x": None}
 *   5. Raw newlines inside string values (very common with file content)
 *   6. Truncation when the model hits max_tokens mid-object
 *   7. An empty string for a no-argument tool
 *   8. Single-quoted keys/strings
 *
 * Each repair is applied only after cheaper attempts fail, and we re-parse
 * after each one, so a well-formed payload takes the fast path with zero
 * mutation. `strategy` records what was needed — the UI can surface a hint if
 * one model is constantly needing repairs, which usually means it's the wrong
 * model for tool use.
 *
 * If everything fails we do NOT throw. The loop turns the failure into a
 * tool_result with is_error, and the model corrects itself on the next turn —
 * which is far better UX than crashing a session.
 */

export interface RepairResult {
  ok: boolean;
  value: Record<string, unknown>;
  /** True when the raw text did not parse as-is. */
  repaired: boolean;
  /** Which repairs were applied, in order. Empty on the fast path. */
  strategies: string[];
  error?: string;
}

export function parseToolArguments(raw: string): RepairResult {
  const strategies: string[] = [];
  const text = raw.trim();

  // A no-argument tool commonly streams "" or "{}". Both mean "no arguments".
  if (text === '' || text === '{}') {
    return { ok: true, value: {}, repaired: false, strategies };
  }

  // Fast path — the overwhelming majority of calls, including from cheap models.
  const direct = tryParseObject(text);
  if (direct) return { ok: true, value: direct, repaired: false, strategies };

  let candidate = text;

  // 1. Unwrap a markdown fence, then 2. isolate the outermost {...} from prose.
  const unfenced = stripCodeFence(candidate);
  if (unfenced !== candidate) {
    candidate = unfenced;
    strategies.push('strip-code-fence');
    const parsed = tryParseObject(candidate);
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
  }

  const extracted = extractOutermostObject(candidate);
  if (extracted && extracted !== candidate) {
    candidate = extracted;
    strategies.push('extract-object');
    const parsed = tryParseObject(candidate);
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
  }

  // 3 + 4. Cheap textual fixes that never change well-formed JSON.
  const cleaned = fixTrailingCommas(fixPythonLiterals(candidate));
  if (cleaned !== candidate) {
    candidate = cleaned;
    strategies.push('literals-and-commas');
    const parsed = tryParseObject(candidate);
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
  }

  // 5. Escape control characters that appear raw inside string literals. This
  //    is the most common failure when a model writes file content inline.
  const escaped = escapeControlCharsInStrings(candidate);
  if (escaped !== candidate) {
    candidate = escaped;
    strategies.push('escape-control-chars');
    const parsed = tryParseObject(candidate);
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
  }

  // 6. Truncated output: close whatever is still open.
  const completed = completeTruncated(candidate);
  if (completed !== candidate) {
    strategies.push('complete-truncated');
    const parsed = tryParseObject(completed);
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
    candidate = completed;
  }

  // 8. Last resort. Single-quote conversion is genuinely risky (apostrophes in
  //    prose become quote characters), so it only runs once everything else has
  //    failed and the payload is already unusable.
  const requoted = convertSingleQuotes(candidate);
  if (requoted !== candidate) {
    strategies.push('single-quotes');
    const parsed = tryParseObject(completeTruncated(requoted));
    if (parsed) return { ok: true, value: parsed, repaired: true, strategies };
  }

  return {
    ok: false,
    value: {},
    repaired: true,
    strategies,
    error: `Could not parse tool arguments as JSON. Received: ${truncateForMessage(raw)}`,
  };
}

// ---------------------------------------------------------------------------

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    // Tool arguments are always an object. A bare array or scalar means we
    // grabbed the wrong span of text, so reject and let repairs continue.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return match?.[1]?.trim() ?? text;
}

/**
 * Find the outermost balanced {...}, ignoring braces inside string literals.
 * Handles "Sure! Here it is: {...} Let me know if that works."
 */
function extractOutermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced — return from the first brace so completeTruncated can finish it.
  return text.slice(start);
}

/** Remove commas that immediately precede a closing brace or bracket. */
function fixTrailingCommas(text: string): string {
  return mapOutsideStrings(text, (segment) => segment.replace(/,(\s*[}\]])/g, '$1'));
}

/** Python's True/False/None leak in from models trained heavily on Python. */
function fixPythonLiterals(text: string): string {
  return mapOutsideStrings(text, (segment) =>
    segment
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null'),
  );
}

/**
 * Apply a transform only to the parts of `text` outside string literals, so we
 * never corrupt user content (a file containing the word `None`, say).
 */
function mapOutsideStrings(text: string, fn: (segment: string) => string): string {
  let out = '';
  let buffer = '';
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      out += fn(buffer);
      buffer = '';
      out += ch;
      inString = true;
      continue;
    }
    buffer += ch;
  }
  return out + fn(buffer);
}

/**
 * JSON forbids raw control characters inside strings, but models routinely emit
 * literal newlines when writing file content into a `content` argument.
 * Re-escape them rather than rejecting the call.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    switch (ch) {
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += ch.charCodeAt(0) < 0x20 ? '' : ch;
    }
  }
  return out;
}

/**
 * Close a payload cut off mid-flight (the model hit max_tokens).
 *
 * Strategy: track the bracket stack and string state, then close the string if
 * open and unwind the stack. A dangling `"key":` with no value is dropped
 * entirely — a half-written key is worse than a missing one, because the model
 * can recover from a missing argument but not from a corrupted value.
 */
function completeTruncated(text: string): string {
  interface Frame {
    kind: '{' | '[';
    /** Index just past the last ',' or opening bracket at this depth. */
    elementStart: number;
    /** Whether the current object entry has reached its ':' yet. */
    sawColon: boolean;
  }

  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    const top = stack[stack.length - 1];
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      stack.push({ kind: ch, elementStart: i + 1, sawColon: false });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',' && top) {
      top.elementStart = i + 1;
      top.sawColon = false;
    } else if (ch === ':' && top?.kind === '{') {
      top.sawColon = true;
    }
  }

  if (!inString && stack.length === 0) return text;

  let out = text;
  if (inString) out += '"';

  const innermost = stack[stack.length - 1];

  // A truncated object entry is unrecoverable: a half-written key or a key with
  // no value would parse as corrupt data, and a model recovers far better from
  // a *missing* argument than from a wrong one. So drop the partial entry back
  // to its last clean separator.
  if (innermost?.kind === '{') {
    const fragment = out.slice(innermost.elementStart);
    const hasValue = innermost.sawColon && /:\s*\S/.test(fragment);
    if (!hasValue) {
      out = out.slice(0, innermost.elementStart).replace(/,\s*$/, '');
    }
  }

  // Tidy any separator the cut left dangling.
  out = out.replace(/,\s*$/, '');

  while (stack.length > 0) {
    out += stack.pop()!.kind === '{' ? '}' : ']';
  }
  return out;
}

/** Convert 'single-quoted' keys and values to double quotes. Genuinely lossy. */
function convertSingleQuotes(text: string): string {
  if (!text.includes("'")) return text;
  return text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => {
    return `"${inner.replace(/"/g, '\\"')}"`;
  });
}

function truncateForMessage(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}... (${trimmed.length} chars)`;
}
