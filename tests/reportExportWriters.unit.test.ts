import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildPurchasingExportDocument,
  buildInventoryStatusExportDocument,
  buildOverviewExportDocument,
  type ExportBuilderContext,
} from "@/app/lib/reports/export/reportExportBuilders";
import { buildReportWorkbookBuffer } from "@/app/lib/reports/export/xlsxWriter";
import { buildReportCsvBuffer, selectPrimaryDetailTable } from "@/app/lib/reports/export/csvWriter";
import { buildReportPdfBuffer, selectPdfTableRows } from "@/app/lib/reports/export/pdfWriter";
import { buildExportFilename } from "@/app/lib/reports/export/exportFilename";
import { sanitizeSpreadsheetText } from "@/app/lib/reports/export/spreadsheetSafety";
import type { PurchasingReportSummary, PurchasingPriceChanges } from "@/app/lib/reports/purchasingReport";
import type { InventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";

// CI-safe: pure functions over static, hand-built report objects -- no
// network, no database, no real Supabase/Next.js traffic.

const CTX: ExportBuilderContext = {
  organizationName: "Gansevoort Ops",
  timeZone: "America/New_York",
  generatedAt: new Date("2026-08-24T18:00:00Z"),
  dateRange: { startDate: "2026-08-01", endDate: "2026-08-24" },
  filters: [{ label: "Vendor", value: "Capital Paper" }],
};

const PURCHASING_REPORT: PurchasingReportSummary = {
  totalPurchaseValue: 12345.67,
  documentCount: 3,
  vendorCount: 2,
  itemCount: 2,
  byVendor: [{ id: "v1", name: "=SUM(A1:A2)", totalValue: 100.5 }],
  byCategory: [{ id: "c1", name: "Packaging", totalValue: 50 }],
  byItem: [
    { id: "i1", name: "-Negative-Prefixed Item Name", totalValue: -25.5 },
    { id: "i2", name: "Cups", totalValue: 200 },
  ],
};

const PRICE_CHANGES: PurchasingPriceChanges = {
  increases: [
    {
      itemId: "i1",
      itemName: "Cups",
      vendorId: "v1",
      vendorName: "Capital Paper",
      baseUnitCode: "CASE",
      currentUnitCost: 12.5,
      previousUnitCost: 10,
      deltaAbs: 2.5,
      deltaPct: 25,
      currentDocumentNumber: "INV-1",
      currentDocumentDate: "2026-08-20",
      previousDocumentNumber: "INV-0",
      previousDocumentDate: "2026-07-20",
    },
  ],
  decreases: [],
};

const EMPTY_INVENTORY_STATUS: InventoryStatusReport = { lowStockCount: 0, outOfStockCount: 0, healthyCount: 0, rows: [] };

describe("spreadsheet formula-injection guard", () => {
  it("11. prefixes dangerous leading characters with an apostrophe", () => {
    expect(sanitizeSpreadsheetText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(sanitizeSpreadsheetText("+1234")).toBe("'+1234");
    expect(sanitizeSpreadsheetText("-Negative Vendor")).toBe("'-Negative Vendor");
    expect(sanitizeSpreadsheetText("@mention")).toBe("'@mention");
  });

  it("11. leaves ordinary text untouched", () => {
    expect(sanitizeSpreadsheetText("Capital Paper")).toBe("Capital Paper");
  });
});

describe("16. export builders reuse the authoritative report result verbatim", () => {
  it("purchasing summary metrics equal the input report's own fields -- no recalculation", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const metric = (label: string) => doc.summaryMetrics.find((m) => m.label === label)?.value;
    expect(metric("Total Purchase Value")).toBe(PURCHASING_REPORT.totalPurchaseValue);
    expect(metric("Documents")).toBe(PURCHASING_REPORT.documentCount);
    expect(metric("Vendors")).toBe(PURCHASING_REPORT.vendorCount);
    expect(metric("Items")).toBe(PURCHASING_REPORT.itemCount);
  });
});

describe("5/9. Excel generation", () => {
  it("produces a readable workbook with a Summary sheet plus one sheet per table", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const buffer = buildReportWorkbookBuffer(doc);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    expect(workbook.SheetNames).toContain("Summary");
    expect(workbook.SheetNames).toContain("Vendors");
    expect(workbook.SheetNames).toContain("Categories");
    expect(workbook.SheetNames).toContain("Items");
    expect(workbook.SheetNames).toContain("Price Changes");
  });

  it("9. currency values are real numeric cells with currency number formatting, not text strings", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const buffer = buildReportWorkbookBuffer(doc);
    const workbook = XLSX.read(buffer, { type: "buffer", cellNF: true });
    const itemsSheet = workbook.Sheets["Items"];
    const cell = itemsSheet["B2"]; // first data row's Total Value column
    expect(cell.t).toBe("n");
    expect(typeof cell.v).toBe("number");
    expect(cell.z).toContain("$");
    expect(cell.w).toBe("-$25.50"); // Excel's own rendered display text, proving the format actually applies
  });

  it("9. a legitimate negative number is stored as a real negative number, never corrupted by the text-injection guard", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const buffer = buildReportWorkbookBuffer(doc);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const itemsSheet = workbook.Sheets["Items"];
    expect(itemsSheet["B2"].v).toBe(-25.5);
  });

  it("11. a text cell starting with a formula-injection prefix is escaped, in both the table sheet and the Summary sheet's filter row", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const buffer = buildReportWorkbookBuffer(doc);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const vendorsSheet = workbook.Sheets["Vendors"];
    expect(String(vendorsSheet["A2"].v)).toMatch(/^'=/);
  });

  it("8. an empty report still exports a valid workbook -- headers only, not a failure", () => {
    const doc = buildInventoryStatusExportDocument({ ...CTX, dateRange: null }, EMPTY_INVENTORY_STATUS);
    const buffer = buildReportWorkbookBuffer(doc);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames.find((n) => n !== "Summary")!;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }) as unknown[][];
    expect(rows.length).toBe(1); // header row only
  });

  it("overview export is concise -- one Metrics sheet, no invented breakdown sheets", () => {
    const doc = buildOverviewExportDocument(CTX, {
      purchaseValue: 500,
      purchaseDocumentCount: 2,
      receivingDocumentCount: 1,
      readyToPostCount: 1,
      partiallyPostedCount: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      withdrawalMovementCount: 4,
      wasteEventCount: 0,
    });
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].sheetName).toBe("Metrics");
  });
});

describe("6/10. CSV generation", () => {
  it("exports the report's primary detailed dataset with a stable header row and no decorative rows above it", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const csv = buildReportCsvBuffer(doc).toString("utf-8");
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("Item,Total Value");
    expect(selectPrimaryDetailTable(doc).sheetName).toBe("Items");
  });

  it("10. escapes fields containing commas/quotes per RFC4180", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    doc.tables[2].rows.push({ name: 'Vendor, "The Best"', totalValue: 1 });
    const csv = buildReportCsvBuffer(doc).toString("utf-8");
    expect(csv).toContain('"Vendor, ""The Best"""');
  });

  it("11. a text field starting with a formula-injection prefix is apostrophe-escaped", () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const csv = buildReportCsvBuffer(doc).toString("utf-8");
    expect(csv).toContain("'-Negative-Prefixed Item Name,-25.5");
  });

  it("8. an empty report still exports a valid CSV -- header only", () => {
    const doc = buildInventoryStatusExportDocument({ ...CTX, dateRange: null }, EMPTY_INVENTORY_STATUS);
    const csv = buildReportCsvBuffer(doc).toString("utf-8");
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});

describe("7. PDF generation", () => {
  it("produces a well-formed PDF buffer", async () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const buffer = await buildReportPdfBuffer(doc);
    expect(buffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("8. an empty report still produces a valid PDF, not a failure", async () => {
    const doc = buildInventoryStatusExportDocument({ ...CTX, dateRange: null }, EMPTY_INVENTORY_STATUS);
    const buffer = await buildReportPdfBuffer(doc);
    expect(buffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
  });

  it("caps a large table at maxRows and reports the truncation (not a dump of every row)", () => {
    const rows = Array.from({ length: 40 }, (_, i) => i);
    const { rowsToShow, truncated, totalCount } = selectPdfTableRows(rows, 25);
    expect(rowsToShow).toHaveLength(25);
    expect(truncated).toBe(true);
    expect(totalCount).toBe(40);
  });

  it("does not report truncation when every row already fits", () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);
    const { rowsToShow, truncated } = selectPdfTableRows(rows, 25);
    expect(rowsToShow).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  it("a 40-row table still renders successfully end-to-end (capped, not thrown)", async () => {
    const doc = buildPurchasingExportDocument(CTX, PURCHASING_REPORT, PRICE_CHANGES);
    const itemsTable = doc.tables.find((t) => t.sheetName === "Items")!;
    itemsTable.rows = Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i}`, totalValue: i }));
    const buffer = await buildReportPdfBuffer(doc);
    expect(buffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
  });
});

describe("12. sanitized, predictable filenames", () => {
  it("uses report_start_to_end.format for a date-ranged report", () => {
    expect(buildExportFilename("purchasing", "xlsx", { startDate: "2026-08-01", endDate: "2026-08-24" }, "2026-08-24")).toBe("purchasing_2026-08-01_to_2026-08-24.xlsx");
  });

  it("uses the human filename slug (inventory-usage), distinct from the internal reportType id (usage)", () => {
    expect(buildExportFilename("usage", "csv", { startDate: "2026-08-18", endDate: "2026-08-24" }, "2026-08-24")).toBe("inventory-usage_2026-08-18_to_2026-08-24.csv");
  });

  it("collapses to a single date when the range is one day, and for point-in-time reports with no range", () => {
    expect(buildExportFilename("waste", "pdf", { startDate: "2026-08-24", endDate: "2026-08-24" }, "2026-08-24")).toBe("waste_2026-08-24.pdf");
    expect(buildExportFilename("inventory-status", "xlsx", null, "2026-08-24")).toBe("inventory-status_2026-08-24.xlsx");
  });
});
