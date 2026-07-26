/**
 * SQLite persistence, using node:sqlite — built into Node 22.5+, so forge has
 * zero native dependencies and installs cleanly on a fresh Windows machine
 * without a compiler toolchain. (better-sqlite3 would need node-gyp.)
 *
 * Three tables:
 *   sessions  one row per `forge` invocation in a directory
 *   messages  the full transcript, so --resume replays exactly
 *   usage     one row per API request, for /cost history
 *
 * The transcript is stored as serialized content blocks rather than rendered
 * text, because a resumed session must reproduce the *same bytes* it would have
 * sent originally — otherwise resuming silently starts from a cold cache.
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { databasePath } from '../config/load.ts';

/**
 * `node:sqlite` is resolved at runtime, not by a static import.
 *
 * Two bundler problems make this necessary:
 *
 *   1. esbuild's builtin-module list predates node:sqlite, so a static
 *      `import … from 'node:sqlite'` is rewritten to a bare `'sqlite'`, which
 *      resolves to nothing and kills the app at startup. Marking it external
 *      doesn't help — the rewrite happens after resolution.
 *   2. The obvious workaround, `createRequire(import.meta.url)`, breaks in the
 *      CJS bundle used by the Electron main process: esbuild compiles
 *      `import.meta.url` to `undefined` there, and createRequire throws.
 *
 * `process.getBuiltinModule` sidesteps both. It is synchronous (so nothing else
 * has to become async), it works identically in CJS and ESM, and the specifier
 * is an opaque runtime string no bundler will touch.
 */
const sqlite = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};
const { DatabaseSync } = sqlite;

export interface SessionRow {
  id: string;
  cwd: string;
  title: string | null;
  model_key: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  session_id: string;
  seq: number;
  role: string;
  /** JSON-serialized ContentBlock[]. */
  content: string;
}

export interface UsageRow {
  session_id: string;
  created_at: number;
  model_key: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number;
  uncached_cost: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  cwd         TEXT NOT NULL,
  title       TEXT,
  model_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  model_key           TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  cache_write_tokens  INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cost                REAL NOT NULL,
  uncached_cost       REAL NOT NULL
);

-- --continue resolves "most recent session in this directory".
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, updated_at DESC);
-- /cost aggregates by day.
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
`;

let cached: DatabaseSyncType | null = null;

export function openDatabase(): DatabaseSyncType {
  if (cached) return cached;

  const db = new DatabaseSync(databasePath());
  // WAL keeps a second forge window in another directory from blocking this one.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  cached = db;
  return db;
}

/**
 * Additive migrations for databases created by earlier builds. SQLite has no
 * ADD COLUMN IF NOT EXISTS, so each one probes first — cheap, idempotent, and
 * it keeps existing sessions intact across upgrades.
 */
function migrate(db: DatabaseSyncType): void {
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name?: unknown }>;
  const has = (name: string): boolean => columns.some((c) => c.name === name);

  if (!has('archived')) {
    // 0 = live, 1 = archived (hidden from lists, kept for cost history).
    db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;');
  }

  if (!has('pinned')) {
    // 0 = normal, 1 = pinned to the top of the thread list.
    db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
  }
}

export function closeDatabase(): void {
  if (!cached) return;
  try {
    cached.close();
  } catch {
    // Closing on exit is best-effort; a failure here must never mask the real
    // reason the process is shutting down.
  }
  cached = null;
}
