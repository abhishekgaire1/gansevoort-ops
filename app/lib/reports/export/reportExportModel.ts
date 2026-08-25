/**
 * Reports export foundation -- the ONE shared shape every report's
 * exporter (Excel/CSV/PDF) is built from. Every report-specific builder
 * (see reportExportBuilders.ts) maps an ALREADY-fetched, authoritative
 * report result (the exact same result the on-screen page renders) into
 * this document -- it never recalculates a total, never re-queries the
 * database, and never scrapes rendered HTML. The three format writers
 * (xlsxWriter/csvWriter/pdfWriter) only ever read this document; they
 * have no report-specific knowledge at all, which is what lets a future
 * Sales report plug into the same three writers by producing one of
 * these documents.
 */

export type ReportExportType = "overview" | "purchasing" | "usage" | "inventory-status" | "waste" | "receiving";

export type ReportExportFormat = "xlsx" | "csv" | "pdf";

export interface ReportExportFilterDescriptor {
  label: string;
  value: string;
}

export type ReportExportCellFormat = "text" | "integer" | "decimal" | "currency" | "percent" | "date";

export interface ReportExportMetric {
  label: string;
  value: number | string;
  format?: ReportExportCellFormat;
}

export interface ReportExportColumn {
  key: string;
  header: string;
  format?: ReportExportCellFormat;
}

export interface ReportExportTable {
  /** Excel sheet tab name -- kept short; sanitized/truncated by the xlsx
   * writer (Excel hard-caps sheet names at 31 characters). */
  sheetName: string;
  /** Human display title, used as a PDF section heading. */
  title: string;
  columns: ReportExportColumn[];
  rows: Record<string, string | number | null>[];
  /** Exactly one table in a document should set this -- it's the dataset
   * CSV exports (CSV can only ever represent one flat table). */
  isPrimaryDetail?: boolean;
  /** Whether/how this table appears in the PDF snapshot. Large detail
   * tables are deliberately excluded or capped -- Section 9/10: PDF is a
   * human-readable snapshot, not a full-detail dump. */
  pdf?: { include: boolean; maxRows?: number };
}

export interface ReportExportDateRange {
  startDate: string;
  endDate: string;
}

export interface ReportExportDocument {
  reportType: ReportExportType;
  reportTitle: string;
  organizationName: string;
  timeZone: string;
  generatedAt: Date;
  /** null for point-in-time reports (Inventory Status has no date range --
   * it's current balances, same as the on-screen report). */
  dateRange: ReportExportDateRange | null;
  filters: ReportExportFilterDescriptor[];
  summaryMetrics: ReportExportMetric[];
  tables: ReportExportTable[];
}
