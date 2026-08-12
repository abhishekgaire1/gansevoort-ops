/**
 * Pure "is this a valid withdrawal quantity" check for the simplified
 * quantity-entry screen (withdrawal-unit simplification: an employee always
 * withdraws in the item's own base unit, so there is exactly one quantity
 * field now -- no unit/layout branching remains here).
 *
 * Advisory only -- the RPC remains the sole source of truth for every
 * business rule. This only decides whether Continue/Confirm should be
 * enabled, not whether the backend will ultimately accept the submission.
 */
export function isValidWithdrawalQuantity(value: string): boolean {
  if (value.trim() === "") return false;
  const num = Number(value);
  return Number.isFinite(num) && num > 0;
}
