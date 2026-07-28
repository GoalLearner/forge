/**
 * Rate table for the T2 fixture.
 *
 * `perMille` is parts-per-thousand, so a whole-number field can express a
 * fractional rate without floating-point noise in the tests.
 */

export interface Rate {
  code: string;
  perMille: number;
}

/** Sum of every rate in the list. Returns 0 for an empty list. */
export function total(rs: Rate[]): number {
  return rs.reduce((sum, r) => sum + r.perMille, 0);
}
