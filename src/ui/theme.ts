/**
 * Terminal theme.
 *
 * Colors are chosen from the 16-color ANSI palette rather than truecolor, so
 * they inherit whatever scheme the user has already configured and stay legible
 * on both light and dark backgrounds. A hardcoded hex palette looks great on
 * the author's terminal and unreadable on half of everyone else's.
 *
 * The visual grammar the whole UI follows:
 *
 *   >  cyan      the user's own input
 *   ●  green     a tool that succeeded
 *   ●  red       a tool that failed
 *   ⋯  dim       reasoning / thinking (transient, never persisted)
 *   !  yellow    a notice worth reading
 *   ✗  red       an error
 *
 * The point is that a glance tells you what kind of thing you're looking at,
 * without reading any of it.
 */

export const theme = {
  user: 'cyan',
  assistant: undefined, // terminal default — the main content shouldn't be tinted
  reasoning: 'gray',
  toolRunning: 'yellow',
  toolOk: 'green',
  toolError: 'red',
  notice: 'yellow',
  error: 'red',
  dim: 'gray',
  accent: 'magenta',
  added: 'green',
  removed: 'red',
  hunk: 'cyan',
} as const;

export const glyphs = {
  user: '>',
  tool: '●',
  reasoning: '⋯',
  notice: '!',
  error: '✗',
  bullet: '·',
  pending: '[ ]',
  active: '[>]',
  done: '[x]',
} as const;

/** Spinner frames. Braille dots render correctly in every modern terminal. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
