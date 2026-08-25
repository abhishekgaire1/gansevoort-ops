import type { ReportExportDocument, ReportExportTable } from "./reportExportModel";
import { sanitizeSpreadsheetText } from "./spreadsheetSafety";

/**
 * Reports export foundation -- CSV writer (Section 8). CSV represents
 * exactly ONE flat dataset -- the report's primary detailed table (the
 * table each report builder marks `isPrimaryDetail: true`) -- never a
 * decorative title/metadata block above the header row, so the output
 * stays directly machine-readable/importable.
 */

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function cellToCsvField(value: string | number | null, format: ReportExportTable["columns"][number]["format"]): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  if (format === "text" || format === undefined) return escapeCsvField(sanitizeSpreadsheetText(value));
  return escapeCsvField(value); // numeric-looking columns already carry real numbers, never strings
}

export function selectPrimaryDetailTable(doc: ReportExportDocument): ReportExportTable {
  return doc.tables.find((t) => t.isPrimaryDetail) ?? doc.tables[0];
}

export function buildReportCsvBuffer(doc: ReportExportDocument): Buffer {
  const table = selectPrimaryDetailTable(doc);
  const lines: string[] = [];
  lines.push(table.columns.map((c) => escapeCsvField(c.header)).join(","));
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => cellToCsvField(row[c.key] ?? null, c.format)).join(","));
  }
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}
