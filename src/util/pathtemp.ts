/**
 * Pure path utility: answers whether one path lives inside another directory.
 *
 * This is deliberately filesystem-free — it compares strings, not inodes. That
 * makes it trivially testable and immune to TOCTOU races. The caller is
 * responsible for checking that paths actually exist when that matters.
 *
 * Comparisons are case-insensitive and separator-insensitive so Windows paths
 * (and mixed-slash paths that cross platform boundaries) compare correctly.
 */

/**
 * Returns `true` when `child` is inside (or equal to) `parent`, `false`
 * otherwise. The comparison is case-insensitive and treats `/` and `\`
 * identically; it does not resolve symlinks, `..`, or `.` components because it
 * has no business talking to the filesystem.
 */
export function isInsideDir(child: string, parent: string): boolean {
  const normChild = normalizePathSegment(child);
  const normParent = normalizePathSegment(parent);

  // Equal paths should still match (a directory is "inside" itself for our
  // purposes — the caller wants to skip everything under the temp root).
  if (normChild === normParent) return true;

  // Ensure the parent has a trailing separator so `C:\Temp` does not match
  // `C:\Temp2`. The normalized form always uses `/`, so we append `/`.
  const prefix = normParent.endsWith('/') ? normParent : `${normParent}/`;
  return normChild.startsWith(prefix);
}

/**
 * Reduce a path to a canonical comparison form: lowercase, `/` separators,
 * no trailing slash (unless the path is a root like `c:/`). No filesystem
 * access — this is just string munging.
 */
function normalizePathSegment(p: string): string {
  // Normalize separators, then collapse runs of them.
  let normalized = p.replace(/\\/g, '/').toLowerCase();
  // Collapse multiple consecutive slashes (except leading UNC slashes).
  normalized = normalized.replace(/\/{2,}/g, '/');
  // Strip trailing slash unless we'd end up with an empty string or a bare
  // Windows root like "c:" (keep "c:/").
  if (normalized.length > 1 && normalized.endsWith('/')) {
    // Preserve "c:/" / "d:/" — roots with a drive letter.
    if (normalized.length === 3 && normalized[1] === ':') return normalized;
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
