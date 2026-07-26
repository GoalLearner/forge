/**
 * Session persistence: transcripts, resume, and usage history.
 *
 * The resume path has one requirement that is easy to miss: a resumed
 * transcript must serialize to the *same bytes* as the in-memory one it
 * replaces. If key order shifts (see util/stable-json.ts), the prompt prefix
 * differs, and `--continue` starts from a cold cache — costing up to 50x on the
 * first turn with no visible symptom. That is why content blocks are stored as
 * structured JSON and rebuilt, rather than being re-derived from rendered text.
 */

import { randomUUID } from 'node:crypto';
import type { RunLedgerSummary } from './ledger.ts';
import { openDatabase } from './db.ts';
import { addUsage, EMPTY_TOTALS, type UsageTotals } from './cost.ts';
import type { ModelEntry } from '../config/schema.ts';
import type { ContentBlock, Message, NormalizedUsage } from '../providers/types.ts';

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string | null;
  modelKey: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  cost: number;
  pinned: boolean;
  archived: boolean;
}

export class SessionStore {
  private db = openDatabase();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  create(cwd: string, modelKey: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO sessions (id, cwd, title, model_key, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
      )
      .run(id, cwd, modelKey, now, now);
    return id;
  }

  /**
   * Delete sessions that never became anything — no messages, no usage.
   *
   * A session row should only outlive its process if a message was actually
   * sent; rows without one are launch debris ("(untitled) · 0 msgs" in every
   * list). The age guard keeps this from racing a *concurrently running*
   * frontend that eagerly created its row and hasn't received a first message
   * yet — anything younger than the threshold is left alone.
   */
  /**
   * Hide a thread without destroying anything. The row, transcript, and spend
   * all survive — it just stops appearing in lists and can't be auto-resumed.
   */
  archiveSession(id: string): void {
    this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id);
  }

  /** Bring an archived thread back into the live list. */
  unarchiveSession(id: string): void {
    this.db.prepare('UPDATE sessions SET archived = 0 WHERE id = ?').run(id);
  }

  /** Stick a thread to the top of the list (or release it). */
  setPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  /**
   * Give a thread an explicit name.
   *
   * Unlike setTitleIfUnset (which derives a title once, from the first
   * message), this overwrites — a rename is the user overriding that guess,
   * and it must stick. An empty name clears back to auto-titling.
   */
  renameSession(id: string, title: string): void {
    const trimmed = title.replace(/\s+/g, ' ').trim().slice(0, 120);
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(trimmed || null, id);
  }

  /**
   * Remove a thread and its transcript for good.
   *
   * Usage rows are deliberately KEPT: money was spent, and deleting a thread
   * must never make the all-time cost report understate what was paid.
   * (Per-directory totals join through sessions, so a deleted thread's spend
   * drops out of "this directory" but stays in "today" and "all time".)
   */
  deleteSession(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  pruneEmptySessions(olderThanMs = 10 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `DELETE FROM sessions
         WHERE updated_at < ?
           AND id NOT IN (SELECT DISTINCT session_id FROM messages)
           AND id NOT IN (SELECT DISTINCT session_id FROM usage)`,
      )
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Most recent session in this directory, for `forge --continue`.
   *
   * The `rowid` tie-break is load-bearing: `updated_at` is a millisecond
   * timestamp, and two sessions created in the same millisecond would otherwise
   * order arbitrarily — so `--continue` could silently resume the wrong
   * conversation. rowid is monotonic insertion order, which breaks the tie the
   * way a human would expect.
   */
  findLatest(cwd: string): string | null {
    const row = this.db
      .prepare(
        'SELECT id FROM sessions WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 1',
      )
      .get(cwd) as { id?: string } | undefined;
    return row?.id ?? null;
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(id);
    return row !== undefined;
  }

  /**
   * A title derived from the first user message. Set once — a stable name is
   * more useful for finding a session later than one that tracks the latest
   * topic.
   */
  setTitleIfUnset(id: string, title: string): void {
    const trimmed = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!trimmed) return;
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = \'\')')
      .run(trimmed, id);
  }

  touch(id: string, modelKey?: string): void {
    if (modelKey) {
      this.db
        .prepare('UPDATE sessions SET updated_at = ?, model_key = ? WHERE id = ?')
        .run(Date.now(), modelKey, id);
    } else {
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
  }

  /**
   * List threads. `archived` selects which shelf to read — archived threads
   * are a separate view, never mixed into the live list.
   */
  list(cwd?: string, limit = 20, opts: { archived?: boolean } = {}): SessionSummary[] {
    const archived = opts.archived ? 1 : 0;
    // Pinned first, then most-recent. The pin is a user statement about
    // importance, so it outranks recency rather than merely tie-breaking it.
    const sql = `
      SELECT s.id, s.cwd, s.title, s.model_key, s.created_at, s.updated_at, s.pinned, s.archived,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
             COALESCE((SELECT SUM(cost) FROM usage u WHERE u.session_id = s.id), 0) AS cost
      FROM sessions s
      WHERE s.archived = ?${cwd ? ' AND s.cwd = ?' : ''}
      ORDER BY s.pinned DESC, s.updated_at DESC, s.rowid DESC
      LIMIT ?`;
    const rows = (cwd
      ? this.db.prepare(sql).all(archived, cwd, limit)
      : this.db.prepare(sql).all(archived, limit)) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      cwd: String(r.cwd),
      title: r.title === null ? null : String(r.title),
      modelKey: String(r.model_key),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      messageCount: Number(r.message_count),
      cost: Number(r.cost),
      pinned: Number(r.pinned) === 1,
      archived: Number(r.archived) === 1,
    }));
  }

  /**
   * How many archived threads a directory holds.
   *
   * Drives the "N archived" affordance — without a visible count, archiving is
   * a one-way door with nothing to indicate anything is behind it.
   */
  countArchived(cwd: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE s.archived = 1 AND s.cwd = ?
           AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) > 0`,
      )
      .get(cwd) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Every directory forge has worked in, most recently used first — the
   * "recent projects, one click, no dialog" list. Derived from sessions rather
   * than kept as its own table, so it can never drift out of sync.
   */
  listProjects(limit = 12): Array<{ cwd: string; lastUsed: number; sessions: number }> {
    const rows = this.db
      .prepare(
        `SELECT cwd, MAX(updated_at) AS last_used, COUNT(*) AS sessions
         FROM sessions GROUP BY cwd ORDER BY last_used DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      cwd: String(r.cwd),
      lastUsed: Number(r.last_used),
      sessions: Number(r.sessions),
    }));
  }

  /**
   * Per-request cache hit rates for the header sparkline, oldest first.
   * A tiny window is enough — the chip shows a trend, not a chart.
   */
  recentCacheRates(sessionId: string, count = 16): number[] {
    const rows = this.db
      .prepare(
        `SELECT input_tokens, cached_input_tokens, cache_write_tokens
         FROM usage WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, count) as Array<Record<string, unknown>>;
    return rows
      .map((r) => {
        const total =
          Number(r.input_tokens) + Number(r.cached_input_tokens) + Number(r.cache_write_tokens);
        return total === 0 ? 0 : Number(r.cached_input_tokens) / total;
      })
      .reverse();
  }

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------

  /**
   * Persist the transcript.
   *
   * Rewrites the whole thing rather than appending, because the context guard
   * (agent/truncate.ts) can rewrite history in place — an append-only log would
   * drift out of sync with the array actually being sent to the provider.
   * Transcripts are small enough that this is cheap, and correctness here is
   * worth more than the write savings.
   */
  saveMessages(sessionId: string, messages: readonly Message[]): void {
    const deleteAll = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    const insert = this.db.prepare(
      'INSERT INTO messages (session_id, seq, role, content) VALUES (?, ?, ?, ?)',
    );

    this.db.exec('BEGIN');
    try {
      deleteAll.run(sessionId);
      messages.forEach((message, seq) => {
        insert.run(sessionId, seq, message.role, JSON.stringify(message.content));
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{ role: string; content: string }>;

    const out: Message[] = [];
    for (const row of rows) {
      try {
        const content = JSON.parse(row.content) as ContentBlock[];
        if (Array.isArray(content) && content.length > 0) {
          out.push({ role: row.role === 'assistant' ? 'assistant' : 'user', content });
        }
      } catch {
        // A single corrupt row shouldn't make the whole session unresumable.
        // Dropping it is safe: worst case the model re-reads a file.
      }
    }
    return repairDanglingToolCalls(out);
  }

  // -------------------------------------------------------------------------
  // Run ledgers (Step 4B)
  // -------------------------------------------------------------------------

  /**
   * Persist ONE finalized run ledger.
   *
   * Only finalized summaries are written, so a row can never describe a
   * partially-accounted prompt. Keyed by run id with INSERT OR REPLACE, which
   * makes a double-finalize idempotent rather than double-counting the session.
   */
  saveRunLedger(sessionId: string, summary: RunLedgerSummary): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_ledgers
           (run_id, session_id, created_at, model_key, logical_requests,
            provider_attempts, retries_used, cost_state, cost_nanos, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.runId,
        sessionId,
        Date.now(),
        summary.modelKey,
        summary.logicalRequests,
        summary.providerAttempts,
        summary.retriesUsed,
        summary.cost.state,
        summary.cost.nanos,
        JSON.stringify(summary),
      );
  }

  /**
   * Every finalized run ledger for a session, oldest first.
   *
   * Returns an empty array for sessions recorded before Step 4B. The caller
   * must render that as "no ledger data", never as a zero total — that
   * conflation is the whole reason this table exists.
   */
  runLedgers(sessionId: string): RunLedgerSummary[] {
    const rows = this.db
      .prepare('SELECT summary FROM run_ledgers WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Array<{ summary: string }>;

    const out: RunLedgerSummary[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.summary) as RunLedgerSummary);
      } catch {
        // One unreadable row must not make a whole session unopenable.
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  recordUsage(
    sessionId: string,
    usage: NormalizedUsage,
    modelKey: string,
    entry: ModelEntry,
  ): void {
    const totals = addUsage(EMPTY_TOTALS, usage, entry);
    this.db
      .prepare(
        `INSERT INTO usage
           (session_id, created_at, model_key, input_tokens, cached_input_tokens,
            cache_write_tokens, output_tokens, cost, uncached_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        Date.now(),
        modelKey,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheWriteTokens,
        usage.outputTokens,
        totals.cost,
        totals.uncachedCost,
      );
  }

  totalsForSession(sessionId: string): UsageTotals {
    return this.aggregate('WHERE session_id = ?', [sessionId]);
  }

  /**
   * Everything ever spent working in one directory.
   *
   * Joins through `sessions` because usage rows only carry a session id — the
   * question "what has this project cost me" is the one people actually ask,
   * and it spans many sessions.
   */
  totalsForCwd(cwd: string): UsageTotals {
    return this.aggregate(
      'WHERE session_id IN (SELECT id FROM sessions WHERE cwd = ?)',
      [cwd],
    );
  }

  totalsSince(timestamp: number): UsageTotals {
    return this.aggregate('WHERE created_at >= ?', [timestamp]);
  }

  totalsAllTime(): UsageTotals {
    return this.aggregate('', []);
  }

  /** Per-model breakdown, so a single strong-tier escalation is visible. */
  totalsByModel(sessionId?: string): Array<{ modelKey: string; totals: UsageTotals }> {
    const where = sessionId ? 'WHERE session_id = ?' : '';
    const rows = this.db
      .prepare(
        `SELECT model_key,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(uncached_cost), 0) AS uncached_cost
         FROM usage ${where}
         GROUP BY model_key
         ORDER BY cost DESC`,
      )
      .all(...(sessionId ? [sessionId] : [])) as Array<Record<string, unknown>>;

    return rows.map((r) => ({ modelKey: String(r.model_key), totals: rowToTotals(r) }));
  }

  private aggregate(where: string, params: unknown[]): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(uncached_cost), 0) AS uncached_cost
         FROM usage ${where}`,
      )
      .get(...(params as never[])) as Record<string, unknown> | undefined;

    return row ? rowToTotals(row) : { ...EMPTY_TOTALS };
  }
}

function rowToTotals(row: Record<string, unknown>): UsageTotals {
  return {
    requests: Number(row.requests ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cost: Number(row.cost ?? 0),
    uncachedCost: Number(row.uncached_cost ?? 0),
  };
}

/**
 * Guarantee the transcript is structurally valid before it is resumed.
 *
 * If forge was killed between issuing tool calls and recording their results,
 * the last assistant message holds tool_use blocks with no matching
 * tool_result. Every provider rejects that with a 400, so a crash would make
 * the session permanently unresumable. Synthesizing error results costs one
 * line each and makes the transcript loadable again.
 */
export function repairDanglingToolCalls(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') answered.add(block.tool_use_id);
    }
  }

  const missing: ContentBlock[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && !answered.has(block.id)) {
        missing.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'This tool call did not complete — the previous session ended first.',
          is_error: true,
        });
      }
    }
  }

  if (missing.length === 0) return messages;
  return [...messages, { role: 'user', content: missing }];
}
