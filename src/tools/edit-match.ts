/**
 * Line-ending-tolerant matching for structured edits.
 *
 * The problem this solves, observed in Daily Dogfood 001 against a real file:
 * `read_file` splits on `\n` and rejoins with `\n`, so a CRLF file reaches the
 * model with a `\r` still sitting at the end of every line — invisible when the
 * text is rendered. The model copies what it can see, supplies `old_string`
 * with plain `\n`, and `edit_file`'s exact `indexOf` against the raw CRLF
 * source finds nothing. Forge then rewrote a 199-line file wholesale to make
 * progress. On a 62,000-line file that recovery would be unacceptable.
 *
 * The fix is deliberately narrow: line endings are normalized FOR COMPARISON
 * ONLY, and the replacement is applied to the ORIGINAL string using physical
 * offsets recovered from an explicit index map. Nothing outside the matched
 * span is touched, and the file's own line-ending style survives — including
 * mixed-ending files, which a whole-file normalize-and-rewrite would silently
 * flatten.
 *
 * What is NOT relaxed: spaces, tabs, case, punctuation and Unicode still have
 * to match exactly. This is not fuzzy matching. The only difference forgiven is
 * one that carries no meaning in a text file.
 */

/**
 * A string with CRLF collapsed to LF, plus the map back to physical offsets.
 *
 * `map[i]` is the index in the ORIGINAL string where normalized position `i`
 * begins. It has one extra entry at the end (`map[text.length] === original
 * .length`) so a half-open normalized range `[start, end)` always maps to the
 * half-open physical range `[map[start], map[end])` — including a match that
 * runs to the very end of the file.
 */
export interface NormalizedText {
  text: string;
  map: number[];
}

/**
 * Collapse CRLF to LF, recording where each normalized character came from.
 *
 * A LONE `\r` (not followed by `\n`) is deliberately left alone rather than
 * treated as a line boundary. Classic Mac line endings are effectively extinct,
 * and a stray `\r` inside a line is far more likely to be intentional data —
 * silently treating it as a newline would make matching LESS predictable, which
 * is the opposite of the goal here.
 */
export function normalizeForMatch(original: string): NormalizedText {
  let text = '';
  const map: number[] = [];

  let i = 0;
  while (i < original.length) {
    map.push(i);
    if (original.charCodeAt(i) === 13 /* \r */ && original.charCodeAt(i + 1) === 10 /* \n */) {
      text += '\n';
      i += 2; // the pair collapses to one normalized character
    } else {
      text += original[i];
      i += 1;
    }
  }
  // End sentinel: lets a match that ends at EOF map its exclusive end offset.
  map.push(original.length);

  return { text, map };
}

/** Half-open physical span of a match, in ORIGINAL-string indices. */
export interface PhysicalSpan {
  start: number;
  end: number;
}

/**
 * Every logical occurrence of `needle` in `haystack`, as physical spans.
 *
 * Matching happens entirely in normalized space; the spans returned are
 * physical, so callers never do arithmetic on normalized offsets against the
 * original string — the mistake that would silently corrupt a CRLF file.
 *
 * Occurrences are non-overlapping and returned in order. Two spans that differ
 * physically (one CRLF, one LF) but normalize to the same text count as two
 * separate matches, which is what keeps the uniqueness guarantee honest.
 */
export function findLogicalMatches(haystack: string, needle: string): PhysicalSpan[] {
  if (needle === '') return [];

  const source = normalizeForMatch(haystack);
  const target = normalizeForMatch(needle).text;
  if (target === '') return [];

  const spans: PhysicalSpan[] = [];
  let at = source.text.indexOf(target);
  while (at !== -1) {
    spans.push({ start: source.map[at]!, end: source.map[at + target.length]! });
    at = source.text.indexOf(target, at + target.length);
  }
  return spans;
}

/** Which physical line ending a stretch of text uses. */
export type LineEndingStyle = '\r\n' | '\n';

/**
 * Choose the line ending for replacement text.
 *
 * Deterministic, in priority order:
 *   1. the matched span's own style, when it contains a line break
 *   2. otherwise the file's dominant style (CRLF wins only if CRLF is present
 *      and strictly more common than bare LF)
 *   3. otherwise LF
 *
 * Step 2 matters for a single-line edit in a CRLF file: the span itself carries
 * no evidence, so a multi-line replacement has to take the file's word for it,
 * and a mixed file resolves to whichever style actually dominates rather than
 * to whichever happened to appear first.
 */
export function replacementStyle(original: string, span: PhysicalSpan): LineEndingStyle {
  const matched = original.slice(span.start, span.end);
  if (matched.includes('\r\n')) return '\r\n';
  if (matched.includes('\n')) return '\n';

  const crlf = countOf(original, '\r\n');
  const allLf = countOf(original, '\n');
  const bareLf = allLf - crlf; // every CRLF also contains an LF
  return crlf > 0 && crlf >= bareLf ? '\r\n' : '\n';
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * Re-style the line breaks inside replacement text.
 *
 * Applied only to `new_string`, never to the rest of the file. The incoming
 * text is normalized first so a model that supplies mixed endings in its
 * replacement still produces a consistent result.
 */
export function applyStyle(text: string, style: LineEndingStyle): string {
  const normalized = normalizeForMatch(text).text;
  return style === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * Splice replacements into the original string at physical spans.
 *
 * Built by walking forward and copying the untouched stretches verbatim, so
 * every byte outside a replaced span is preserved exactly — BOM, trailing
 * newline or its absence, unrelated mixed line endings and all.
 */
export function spliceSpans(
  original: string,
  spans: readonly PhysicalSpan[],
  replacementFor: (span: PhysicalSpan) => string,
): string {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += original.slice(cursor, span.start);
    out += replacementFor(span);
    cursor = span.end;
  }
  out += original.slice(cursor);
  return out;
}
