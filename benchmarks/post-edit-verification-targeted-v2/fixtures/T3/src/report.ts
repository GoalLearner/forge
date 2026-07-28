/**
 * Plain-text rendering of stored entries.
 *
 * Tab-separated so a column can be added or asserted without a formatting
 * library, and so a test can split a row on a single unambiguous character.
 */

import type { Entry } from './store.ts';

/** One row per entry: id, label, amount. Empty input renders an empty string. */
export function render(entries: Entry[]): string {
  return entries.map((e) => `${e.id}\t${e.label}\t${e.amount}`).join('\n');
}
