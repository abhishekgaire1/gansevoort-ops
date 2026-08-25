import PDFDocument from "pdfkit";
import type { ReportExportDocument, ReportExportTable } from "./reportExportModel";

/**
 * Reports export foundation -- PDF writer (Section 9/10). Built entirely
 * from the same structured ReportExportDocument the Excel/CSV writers
 * use -- generated server-side with pdfkit (pure Node, vector text/
 * drawing, no headless browser/screenshot/DOM-print pipeline of any
 * kind). Print-friendly by design: white page background, restrained
 * branding, no full-bleed dark panels that would drain a printer.
 *
 * Large detail tables are deliberately capped (`pdf.maxRows`, default
 * 25) with a pointer back to the Excel export for full detail -- this is
 * a human-readable snapshot, not a dump of every row.
 */

const PAGE_MARGIN = 50;
const DEFAULT_MAX_ROWS = 25;
const INK_DARK = "#18181b"; // zinc-900 -- text only, never a fill background
const INK_MUTED = "#71717a"; // zinc-500
const RULE_COLOR = "#d4d4d8"; // zinc-300

function formatMetricValue(value: number | string, format: string | undefined): string {
  if (typeof value === "string") return value;
  if (format === "currency") return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
  if (format === "percent") return `${value.toFixed(1)}%`;
  if (format === "decimal") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString();
}

function formatCellValue(value: string | number | null, format: string | undefined): string {
  if (value === null) return "—";
  if (typeof value === "number") {
    if (format === "currency") return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
    if (format === "percent") return `${value.toFixed(1)}%`;
    if (format === "decimal") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return value.toLocaleString();
  }
  return value;
}

function ensureSpace(doc: PDFKit.PDFDocument, neededHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

/** Pure, directly-testable row-capping decision (Section 9: "Showing top
 * N of TOTAL. Download Excel for complete detail." instead of dumping
 * every row) -- pulled out of drawTable() because pdfkit embeds glyph-
 * indexed fonts even for the standard 14 fonts, so a PDF's own text is
 * never byte-searchable and this contract can't be verified by scanning
 * rendered PDF output. */
export function selectPdfTableRows<T>(rows: T[], maxRows: number): { rowsToShow: T[]; truncated: boolean; totalCount: number } {
  return { rowsToShow: rows.slice(0, maxRows), truncated: rows.length > maxRows, totalCount: rows.length };
}

function drawTable(doc: PDFKit.PDFDocument, table: ReportExportTable, maxRows: number) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / table.columns.length;
  const { rowsToShow, truncated, totalCount } = selectPdfTableRows(table.rows, maxRows);

  ensureSpace(doc, 40);
  doc.moveDown(0.5);
  doc.fillColor(INK_DARK).fontSize(12).font("Helvetica-Bold").text(table.title);
  doc.moveDown(0.3);

  const headerY = doc.y;
  doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_MUTED);
  table.columns.forEach((col, i) => {
    doc.text(col.header.toUpperCase(), doc.page.margins.left + i * colWidth, headerY, { width: colWidth - 6, ellipsis: true });
  });
  doc.moveDown(0.4);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE_COLOR)
    .stroke();
  doc.moveDown(0.3);

  if (rowsToShow.length === 0) {
    doc.fontSize(9).font("Helvetica").fillColor(INK_MUTED).text("No data for this selection.");
    doc.moveDown(0.5);
    return;
  }

  doc.font("Helvetica").fillColor(INK_DARK).fontSize(9);
  for (const row of rowsToShow) {
    ensureSpace(doc, 16);
    const rowY = doc.y;
    table.columns.forEach((col, i) => {
      doc.text(formatCellValue(row[col.key] ?? null, col.format), doc.page.margins.left + i * colWidth, rowY, { width: colWidth - 6, ellipsis: true });
    });
    doc.moveDown(0.35);
  }

  if (truncated) {
    doc.moveDown(0.2);
    doc
      .fontSize(8)
      .font("Helvetica-Oblique")
      .fillColor(INK_MUTED)
      .text(`Showing top ${maxRows} of ${totalCount}. Download Excel for complete detail.`);
  }
  doc.moveDown(0.6);
}

export function buildReportPdfBuffer(doc: ReportExportDocument): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "LETTER", margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  pdf.fillColor(INK_MUTED).fontSize(9).font("Helvetica-Bold").text("GANSEVOORT OPS", { characterSpacing: 1 });
  pdf.moveDown(0.2);
  pdf.fillColor(INK_DARK).fontSize(18).font("Helvetica-Bold").text(doc.reportTitle);
  pdf.moveDown(0.2);

  const metaLines: string[] = [doc.organizationName];
  if (doc.dateRange) metaLines.push(`${doc.dateRange.startDate} to ${doc.dateRange.endDate}`);
  for (const filter of doc.filters) metaLines.push(`${filter.label}: ${filter.value}`);
  metaLines.push(`Generated ${doc.generatedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${doc.timeZone})`);
  pdf.fontSize(9).font("Helvetica").fillColor(INK_MUTED).text(metaLines.join("  •  "));
  pdf.moveDown(0.5);
  pdf
    .moveTo(pdf.page.margins.left, pdf.y)
    .lineTo(pdf.page.width - pdf.page.margins.right, pdf.y)
    .strokeColor(RULE_COLOR)
    .stroke();
  pdf.moveDown(0.6);

  if (doc.summaryMetrics.length > 0) {
    pdf.fontSize(12).font("Helvetica-Bold").fillColor(INK_DARK).text("Summary");
    pdf.moveDown(0.3);
    pdf.fontSize(10).font("Helvetica");
    for (const metric of doc.summaryMetrics) {
      ensureSpace(pdf, 16);
      const y = pdf.y;
      pdf.fillColor(INK_MUTED).text(metric.label, pdf.page.margins.left, y, { width: 220, continued: false });
      pdf.fillColor(INK_DARK).text(formatMetricValue(metric.value, metric.format), pdf.page.margins.left + 220, y);
      pdf.moveDown(0.3);
    }
    pdf.moveDown(0.5);
  }

  for (const table of doc.tables) {
    if (!table.pdf?.include) continue;
    drawTable(pdf, table, table.pdf.maxRows ?? DEFAULT_MAX_ROWS);
  }

  pdf.end();
  return finished;
}
