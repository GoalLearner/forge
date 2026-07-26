/**
 * File logging for the desktop app.
 *
 * A packaged Electron app on Windows has no console: `console.log` in the main
 * process goes nowhere the user can reach, and a crash in the renderer is
 * completely silent. Without a log on disk, "it didn't start" is unanswerable.
 *
 * Everything lands in ~/.forge/desktop.log, which is the first thing to ask for
 * when something goes wrong.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LOG_PATH = join(process.env.FORGE_HOME ?? join(homedir(), '.forge'), 'desktop.log');
const MAX_BYTES = 512 * 1024;

let rotated = false;

export function logPath(): string {
  return LOG_PATH;
}

export function log(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const line = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    message,
    detail === undefined ? '' : formatDetail(detail),
  ]
    .filter(Boolean)
    .join(' ');

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });

    // Keep one previous log rather than growing without bound. Checked once per
    // process so a chatty session doesn't stat the file on every line.
    if (!rotated) {
      rotated = true;
      try {
        if (statSync(LOG_PATH).size > MAX_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.old`);
      } catch {
        /* no existing log, or rename raced another instance */
      }
    }

    appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Logging must never be the thing that breaks the app.
  }

  // Also emit to stdout, which is useful when launched from a terminal.
  if (level === 'error') console.error(line);
  else console.log(line);
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return `\n    ${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  }
  try {
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
