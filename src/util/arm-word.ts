/**
 * The word a destructive-command prompt demands you type before it will arm.
 *
 * Pure string work, kept out of the Electron main file so it can actually be
 * tested — importing main.ts into a test pulls in `electron`, which will not
 * load outside an Electron runtime.
 *
 * The word should name the THING being acted on, because that is what the user
 * needs to recognise before approving. Walking from the end of the command
 * finds the operand; flags, assignments and bare numbers are skipped because
 * none of them identify anything ("type 20 to arm" teaches nothing).
 */
export function deriveArmWord(detail: string): string {
  const firstLine = detail.split('\n')[0] ?? '';
  const tokens = firstLine
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''));
  for (let i = tokens.length - 1; i > 0; i--) {
    const token = tokens[i]!;
    if (token.startsWith('-') || token.includes('=')) continue;
    // A bare number is a flag's value, not a name.
    if (/^\d+$/.test(token)) continue;
    // Use the final path segment so "Type dist to arm" instead of a full path.
    const segment = token.split(/[\\/]/).filter(Boolean).pop();
    if (segment) return segment.toLowerCase();
  }
  return (tokens[0] ?? 'allow').toLowerCase();
}
