/**
 * Deterministic JSON serialization.
 *
 * This exists for one reason: prompt caching is a *byte* prefix match. If tool
 * schemas or recorded tool-call arguments serialize with different key order on
 * different turns, the prefix changes, the cache misses, and input tokens cost
 * up to 50x more (DeepSeek V4 Flash: $0.0028/M cached vs $0.14/M uncached).
 *
 * `JSON.stringify` preserves insertion order, which is stable for a single
 * object but *not* across objects rebuilt from different code paths — e.g. a
 * tool call replayed from SQLite versus one held in memory. Sorting keys makes
 * it stable by construction.
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = sortKeys(source[key]);
  }
  return out;
}
