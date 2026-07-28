/**
 * Entry storage for the T3 fixture.
 *
 * `load()` returns a fixed in-memory list rather than reading a file so the
 * fixture has no I/O, no ordering ambiguity and no dependency on the working
 * directory — the same three entries on every run, on every machine.
 */

export interface Entry {
  id: string;
  label: string;
  amount: number;
}

/** Every stored entry, in insertion order. */
export function load(): Entry[] {
  return [
    { id: 'a1', label: 'Coffee', amount: 350 },
    { id: 'b2', label: 'Books', amount: 1299 },
    { id: 'c3', label: 'Transit', amount: 275 },
  ];
}
