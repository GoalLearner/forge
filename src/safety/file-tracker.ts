/**
 * Read-before-write enforcement.
 *
 * The single most damaging thing an agent does to a codebase is overwrite a
 * file whose current contents it never saw — usually by reconstructing the file
 * "from memory" after the user edited it in their editor, silently reverting
 * their work.
 *
 * The invariant: a file may only be written or edited if this session read it
 * and it has not changed on disk since that read. Cheap to enforce (an mtime
 * and size comparison), and it converts a silent data-loss bug into an error
 * message the model immediately recovers from by re-reading.
 *
 * Creating a genuinely new file is exempt — there is nothing to clobber.
 */

import { statSync } from 'node:fs';

interface Stamp {
  mtimeMs: number;
  size: number;
}

export class StaleFileError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'StaleFileError';
    this.hint = hint;
  }
}

export class FileTracker {
  private seen = new Map<string, Stamp>();

  /** Record that we just read `path` at its current on-disk state. */
  markRead(path: string): void {
    const stamp = stamp_(path);
    if (stamp) this.seen.set(path, stamp);
  }

  /** Forget a path — used after a write, so the next edit re-validates. */
  markWritten(path: string): void {
    const stamp = stamp_(path);
    if (stamp) this.seen.set(path, stamp);
    else this.seen.delete(path);
  }

  hasRead(path: string): boolean {
    return this.seen.has(path);
  }

  /**
   * Throw unless `path` is safe to modify.
   *
   * Both failure messages are written for the *model* to act on, since it is
   * the one that will read them in a tool_result — each says exactly which tool
   * call fixes the situation.
   */
  assertWritable(path: string, displayPath: string): void {
    const current = stamp_(path);

    // New file — nothing to clobber.
    if (!current) return;

    const recorded = this.seen.get(path);
    if (!recorded) {
      throw new StaleFileError(
        `${displayPath} exists but has not been read in this session.`,
        `Call read_file on ${displayPath} first, then retry the edit. This prevents overwriting content you have not seen.`,
      );
    }

    if (recorded.mtimeMs !== current.mtimeMs || recorded.size !== current.size) {
      throw new StaleFileError(
        `${displayPath} changed on disk after you read it.`,
        `Re-read ${displayPath} and re-apply your change against the current contents — someone edited it in the meantime.`,
      );
    }
  }
}

function stamp_(path: string): Stamp | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
