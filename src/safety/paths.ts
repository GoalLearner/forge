/**
 * The path jail.
 *
 * Every file path the model produces passes through here before it reaches the
 * filesystem. The model is not adversarial, but it is frequently *wrong* — it
 * hallucinates absolute paths, follows a symlink out of the tree, or resolves a
 * relative path against the wrong base. And any file it reads may itself
 * contain text steering it somewhere else, so "the model chose this path" is
 * never sufficient justification for touching it.
 *
 * Rules:
 *   1. Resolve to a real, canonical path (realpath where the file exists, so
 *      symlinks cannot be used to escape).
 *   2. The result must sit inside the project root or an explicitly configured
 *      extra root.
 *   3. Sensitive files are denied by default even when inside the root —
 *      credentials shouldn't reach a third-party API by accident. This is a
 *      default, overridable in config, not a hard refusal.
 *
 * Windows note: comparison is case-insensitive on win32, because `C:\Users` and
 * `c:\users` are the same directory and a case-sensitive check would let a
 * trivially different casing slip past the jail.
 */

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Files that commonly hold credentials. Reading one would ship its contents to
 * whichever model provider is configured, so they are denied unless the user
 * explicitly opts in.
 */
const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.aws[\\/]credentials$/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|[\\/])credentials\.json$/i,
  /(^|[\\/])service-account.*\.json$/i,
];

export class PathJailError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PathJailError';
    this.hint = hint;
  }
}

export interface JailOptions {
  /** Project root — the primary allowed directory. */
  root: string;
  /** Additional absolute directories the user has opted into. */
  extraRoots?: string[];
  /** Extra deny patterns from config, as substrings or globs. */
  deny?: string[];
}

export class PathJail {
  private roots: string[];
  private denyPatterns: RegExp[];

  constructor(opts: JailOptions) {
    this.roots = [resolve(opts.root), ...(opts.extraRoots ?? []).map((p) => resolve(p))].map(
      canonicalize,
    );
    this.denyPatterns = [...DEFAULT_DENY_PATTERNS, ...(opts.deny ?? []).map(globToRegExp)];
  }

  get root(): string {
    return this.roots[0]!;
  }

  /**
   * Resolve a model-supplied path and confirm it is inside the jail.
   * Throws PathJailError with an actionable message on any violation.
   */
  resolve(input: string, purpose: 'read' | 'write' = 'read'): string {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new PathJailError('A file path is required.');
    }

    // Reject NUL bytes outright — they truncate paths in some syscalls.
    if (input.includes('\0')) {
      throw new PathJailError('Path contains a null byte.');
    }

    const absolute = isAbsolute(input) ? normalize(input) : resolve(this.root, input);
    const canonical = canonicalize(absolute);

    const containing = this.roots.find((root) => isInside(root, canonical));
    if (!containing) {
      throw new PathJailError(
        `Path is outside the project directory: ${input}`,
        `forge only touches files under ${this.root}. Use a path relative to the project root, or add the directory to permissions.extraRoots in your config.`,
      );
    }

    if (purpose === 'read' && this.isDenied(canonical)) {
      throw new PathJailError(
        `Reading ${input} is blocked — it matches a credentials pattern.`,
        'If this file is genuinely needed and safe, add it to permissions.deny overrides, or paste the relevant part into the conversation yourself.',
      );
    }

    return canonical;
  }

  isDenied(path: string): boolean {
    const rel = relative(this.root, path);
    return this.denyPatterns.some((re) => re.test(path) || re.test(rel));
  }

  /** Project-relative form for display. Falls back to absolute when outside. */
  display(path: string): string {
    const rel = relative(this.root, path);
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : path;
  }
}

/**
 * Canonicalize, resolving symlinks where the path exists.
 *
 * For a path that does not yet exist (creating a new file) we walk up to the
 * nearest existing ancestor and canonicalize that, then re-append the tail.
 * Without this step, a symlinked parent directory would let a write land
 * outside the jail while every string check still passed.
 */
function canonicalize(path: string): string {
  try {
    return normalizeCase(realpathSync(path));
  } catch {
    // Doesn't exist yet — resolve the deepest existing ancestor.
    const parts = normalize(path).split(sep);
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = parts.slice(0, i).join(sep) || sep;
      try {
        const realParent = realpathSync(candidate);
        return normalizeCase(resolve(realParent, parts.slice(i).join(sep)));
      } catch {
        continue;
      }
    }
    return normalizeCase(normalize(path));
  }
}

function normalizeCase(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path;
}

/**
 * True when `child` is `parent` or sits beneath it.
 *
 * Uses path.relative rather than string prefixing, because a naive
 * `child.startsWith(parent)` wrongly accepts `/project-secrets` for the root
 * `/project`.
 */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Minimal glob -> RegExp for deny patterns. Supports `*` and `**`. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(escaped, 'i');
}
