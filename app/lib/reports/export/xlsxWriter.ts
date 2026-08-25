import * as XLSX from "xlsx";
import type { ReportExportCellFormat, ReportExportDocument, ReportExportTable } from "./reportExportModel";
import { sanitizeSpreadsheetText } from "./spreadsheetSafety";

/**
 * Reports export foundation -- Excel writer (Section 6/7). Uses the
 * `xlsx` (SheetJS community) package already installed in this project
 * (app/lib/admin/bulkImportParse.ts already reads spreadsheets with it)
 * -- no new heavy dependency for writing them.
 *
 * Known community-edition limitation: SheetJS's free build has no
 * documented, stable API for Excel freeze panes (that's a Pro-only
 * feature in their offering) -- "freeze headers where useful" is
 * deliberately left undone rather than hand-rolling fragile raw-XML
 * worksheet views for a "where useful" nice-to-have.
 */

const NUMBER_FORMATS: Partial<Record<ReportExportCellFormat, string>> = {
  currency: '"$"#,##0.00',
  integer: "#,##0",
  decimal: "#,##0.00",
  // The source value is already a whole-number percentage (e.g. 12.5
  // meaning "12.5%", matching how the on-screen report already displays
  // it -- see Purchasing's price-change tone rendering). A literal
  // quoted "%" avoids Excel's `%` format specifier, which would
  // incorrectly multiply the stored value by 100.
  percent: '0.0"%"',
  date: "yyyy-mm-dd",
};

function cellForFormat(value: string | number | null, format: ReportExportCellFormat | undefined): string | number | Date | null {
  if (value === null) return null;
  if (format === "date" && typeof value === "string") {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  if (typeof value === "string" && format !== "text" && format !== undefined) return value; // numeric-looking columns always carry real numbers already
  if (typeof value === "string") return sanitizeSpreadsheetText(value);
  return value;
}

function applyColumnWidths(worksheet: XLSX.WorkSheet, headers: string[]) {
  worksheet["!cols"] = headers.map((h) => ({ width: Math.min(40, Math.max(10, h.length + 4)) }));
}

function applyNumberFormats(worksheet: XLSX.WorkSheet, columnFormats: (ReportExportCellFormat | undefined)[], headerRows: number, rowCount: number) {
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < columnFormats.length; c++) {
      const format = columnFormats[c];
      const numberFormat = format ? NUMBER_FORMATS[format] : undefined;
      if (!numberFormat) continue;
      const address = XLSX.utils.encode_cell({ r: r + headerRows, c });
      const cell = worksheet[address];
      if (cell && typeof cell.v === "number") cell.z = numberFormat;
      if (cell && cell.v instanceof Date) cell.z = numberFormat;
    }
  }
}

function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base.slice(0, 28)} ${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function buildTableSheet(table: ReportExportTable): XLSX.WorkSheet {
  const headers = table.columns.map((c) => c.header);
  const aoa: (string | number | Date | null)[][] = [headers];
  for (const row of table.rows) {
    aoa.push(table.columns.map((c) => cellForFormat(row[c.key] ?? null, c.format)));
  }
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  applyColumnWidths(worksheet, headers);
  applyNumberFormats(
    worksheet,
    table.columns.map((c) => c.format),
    1,
    table.rows.length
  );
  return worksheet;
}

function buildSummarySheet(doc: ReportExportDocument): XLSX.WorkSheet {
  const aoa: (string | number | Date | null)[][] = [
    ["Gansevoort Ops"],
    [doc.reportTitle],
    ["Organization", doc.organizationName],
  ];
  if (doc.dateRange) {
    aoa.push(["Date Range", `${doc.dateRange.startDate} to ${doc.dateRange.endDate}`]);
  }
  if (doc.filters.length > 0) {
    for (const filter of doc.filters) aoa.push([filter.label, sanitizeSpreadsheetText(filter.value)]);
  }
  aoa.push(["Generated", doc.generatedAt.toISOString()]);
  aoa.push(["Timezone", doc.timeZone]);
  aoa.push([]);
  aoa.push(["Metric", "Value"]);
  const metricStartRow = aoa.length;
  for (const metric of doc.summaryMetrics) {
    aoa.push([metric.label, typeof metric.value === "string" ? sanitizeSpreadsheetText(metric.value) : metric.value]);
  }

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = [{ width: 28 }, { width: 28 }];

  doc.summaryMetrics.forEach((metric, index) => {
    const numberFormat = metric.format ? NUMBER_FORMATS[metric.format] : undefined;
    if (!numberFormat) return;
    const address = XLSX.utils.encode_cell({ r: metricStartRow + index, c: 1 });
    const cell = worksheet[address];
    if (cell && typeof cell.v === "number") cell.z = numberFormat;
  });

  return worksheet;
}

export function buildReportWorkbookBuffer(doc: ReportExportDocument): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildSummarySheet(doc), "Summary");

  const usedNames = new Set(["summary"]);
  for (const table of doc.tables) {
    XLSX.utils.book_append_sheet(workbook, buildTableSheet(table), safeSheetName(table.sheetName, usedNames));
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
