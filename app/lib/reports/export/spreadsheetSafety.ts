/**
 * Reports export foundation -- CSV/Excel formula-injection guard
 * (Section 27). Applies ONLY to text cells: numeric values (money,
 * quantities, percentages) are always written as real numeric cells by
 * the xlsx/csv writers, never as strings, so a legitimate negative
 * number is never routed through this function at all and can never be
 * "corrupted" by it -- the two concerns are structurally separated
 * rather than solved by a single string heuristic.
 *
 * A text cell (vendor name, item name, status, reason) that happens to
 * start with one of the classic spreadsheet-formula prefixes is
 * prefixed with a leading apostrophe, which both Excel and Google Sheets
 * treat as "force this cell to plain text" -- the standard, minimal
 * mitigation for CSV/formula injection.
 */

const DANGEROUS_PREFIXES = ["=", "+", "-", "@"];

export function sanitizeSpreadsheetText(value: string): string {
  if (value.length === 0) return value;
  return DANGEROUS_PREFIXES.includes(value[0]) ? `'${value}` : value;
}
