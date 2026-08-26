import type { ReportColumnDefinition } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- column allowlisting (Section 8 "Columns").
 * The model may request columns only by KEY from a report's own
 * declared allowlist; anything else is silently dropped here (never
 * rejected with an error, since an unsupported column alongside several
 * valid ones shouldn't block the whole report -- the tool separately
 * tells the manager which of their requested columns were unsupported).
 * Required columns are always present regardless of what was requested.
 * When nothing valid was requested, the report's own defaults are used.
 */
export function resolveColumns(
  available: ReportColumnDefinition[],
  requestedKeys: string[] | undefined,
  defaultKeys: string[],
  requiredKeys: string[],
  maxColumns: number
): ReportColumnDefinition[] {
  const availableKeys = new Set(available.map((c) => c.key));
  const validRequested = (requestedKeys ?? []).filter((k) => availableKeys.has(k));
  const base = validRequested.length > 0 ? validRequested : defaultKeys;
  const withRequired = [...requiredKeys, ...base.filter((k) => !requiredKeys.includes(k))];
  const resolvedKeys = new Set(withRequired.slice(0, Math.max(maxColumns, requiredKeys.length)));
  return available.filter((c) => resolvedKeys.has(c.key));
}

/** Which requested column keys were NOT found in the report's allowlist
 * -- used to build an honest "these columns aren't supported" message,
 * never silently dropped without explanation. */
export function unsupportedColumnKeys(available: ReportColumnDefinition[], requestedKeys: string[] | undefined): string[] {
  if (!requestedKeys) return [];
  const availableKeys = new Set(available.map((c) => c.key));
  return requestedKeys.filter((k) => !availableKeys.has(k));
}

/** Projects a row object down to only the resolved columns' keys --
 * never lets an internal/unrequested field leak into the workbook. */
export function projectRow(row: Record<string, string | number | null>, columns: ReportColumnDefinition[]): Record<string, string | number | null> {
  const projected: Record<string, string | number | null> = {};
  for (const column of columns) {
    projected[column.key] = row[column.key] ?? null;
  }
  return projected;
}
