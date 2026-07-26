/**
 * Suppress Node's ExperimentalWarning for node:sqlite.
 *
 * We use the built-in SQLite deliberately: it means forge has no native
 * dependencies and installs on a bare Windows machine without a compiler
 * toolchain. The tradeoff is a warning banner Node prints on first use, which
 * would appear above the UI on every launch and look like something is broken.
 *
 * Only the SQLite warning is filtered. Everything else still surfaces —
 * blanket-suppressing warnings would hide real deprecations.
 */

const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
