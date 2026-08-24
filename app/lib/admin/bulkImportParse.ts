import * as XLSX from "xlsx";

/**
 * Canonical Item Master bulk import -- client-side parsing/validation
 * (Part 16-19). Runs in the browser (the file never needs to touch the
 * server until the Admin has already reviewed a preview and explicitly
 * confirms), using the `xlsx` package for BOTH CSV and XLSX uniformly --
 * no LibreOffice, no server-side spreadsheet dependency. This is
 * validation/preview only; the actual import RPC
 * (bulk_import_admin_items) re-validates everything server-side
 * regardless (Part 80: never trust this preview as the final guarantee).
 */

export interface ParsedRow {
  rowIndex: number;
  itemNumber: string | null;
  name: string | null;
  categoryName: string | null;
  baseUnitCode: string | null;
  status: "active" | "inactive" | null;
}

export function parseSpreadsheet(buffer: ArrayBuffer): ParsedRow[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });

  return rawRows.map((row, index) => {
    const get = (...keys: string[]): string | null => {
      for (const key of Object.keys(row)) {
        if (keys.includes(key.trim().toLowerCase())) {
          const value = row[key];
          if (value === null || value === undefined) return null;
          const str = String(value).trim();
          return str === "" ? null : str;
        }
      }
      return null;
    };

    const statusRaw = get("status")?.toLowerCase() ?? null;
    const status: "active" | "inactive" | null = statusRaw === "active" || statusRaw === "inactive" ? statusRaw : null;

    return {
      rowIndex: index + 2, // +2: 1-indexed, plus the header row
      itemNumber: get("item number", "itemnumber", "item_number"),
      name: get("canonical name", "name", "item name"),
      categoryName: get("category", "inventory category"),
      baseUnitCode: get("base unit", "unit", "baseunit", "base_unit"),
      status,
    };
  });
}

export type RowIssueCode = "MISSING_NAME" | "UNKNOWN_CATEGORY" | "UNKNOWN_UNIT" | "INVALID_STATUS" | "DUPLICATE_IN_FILE" | "DUPLICATE_ITEM_NUMBER_IN_FILE" | "EXISTING_ITEM_NUMBER" | "POSSIBLE_DUPLICATE";

export interface ValidatedRow {
  rowIndex: number;
  itemNumber: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  baseUnitId: string | null;
  baseUnitCode: string | null;
  status: "active" | "inactive";
  issues: RowIssueCode[];
  /** ready = no issues at all; needsReview = only a possible-duplicate
   * warning (still importable, deliberately, if the Admin proceeds);
   * invalid = a structural problem (missing name, unknown category/unit,
   * malformed status, in-file/existing-number collision) that must be
   * fixed before this row can import. */
  severity: "ready" | "needs_review" | "invalid";
}

export function validateRows(
  rows: ParsedRow[],
  categories: { id: string; name: string }[],
  units: { id: string; code: string }[],
  existingItemNumbers: Set<string>,
  existingItemsByNormalizedName: Map<string, { id: string; name: string; itemNumber: string }>
): ValidatedRow[] {
  const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
  const unitByCode = new Map(units.map((u) => [u.code.trim().toUpperCase(), u]));

  const seenNames = new Map<string, number>(); // normalized name -> first rowIndex
  const seenNumbers = new Map<string, number>();

  return rows.map((row) => {
    const issues: RowIssueCode[] = [];
    const name = row.name?.trim() ?? "";
    if (!name) issues.push("MISSING_NAME");

    const category = row.categoryName ? categoryByName.get(row.categoryName.trim().toLowerCase()) : undefined;
    if (row.categoryName && !category) issues.push("UNKNOWN_CATEGORY");
    if (!row.categoryName) issues.push("UNKNOWN_CATEGORY");

    const unit = row.baseUnitCode ? unitByCode.get(row.baseUnitCode.trim().toUpperCase()) : undefined;
    if (row.baseUnitCode && !unit) issues.push("UNKNOWN_UNIT");
    if (!row.baseUnitCode) issues.push("UNKNOWN_UNIT");

    const status: "active" | "inactive" = row.status ?? "active";

    const normalizedName = name.toUpperCase().replace(/\s+/g, " ");
    if (normalizedName) {
      const firstSeenAt = seenNames.get(normalizedName);
      if (firstSeenAt !== undefined) {
        issues.push("DUPLICATE_IN_FILE");
      } else {
        seenNames.set(normalizedName, row.rowIndex);
      }
    }

    if (row.itemNumber) {
      const firstSeenAt = seenNumbers.get(row.itemNumber);
      if (firstSeenAt !== undefined) {
        issues.push("DUPLICATE_ITEM_NUMBER_IN_FILE");
      } else {
        seenNumbers.set(row.itemNumber, row.rowIndex);
      }
      if (existingItemNumbers.has(row.itemNumber)) {
        issues.push("EXISTING_ITEM_NUMBER");
      }
    }

    let severity: ValidatedRow["severity"] = "ready";
    if (issues.length > 0) severity = "invalid";
    if (normalizedName && existingItemsByNormalizedName.has(normalizedName) && issues.length === 0) {
      issues.push("POSSIBLE_DUPLICATE");
      severity = "needs_review";
    }

    return {
      rowIndex: row.rowIndex,
      itemNumber: row.itemNumber,
      name,
      categoryId: category?.id ?? null,
      categoryName: row.categoryName,
      baseUnitId: unit?.id ?? null,
      baseUnitCode: row.baseUnitCode,
      status,
      issues,
      severity,
    };
  });
}

export const ROW_ISSUE_LABEL: Record<RowIssueCode, string> = {
  MISSING_NAME: "Canonical name is required",
  UNKNOWN_CATEGORY: "Unknown or missing category",
  UNKNOWN_UNIT: "Unknown or missing base unit",
  INVALID_STATUS: "Invalid status",
  DUPLICATE_IN_FILE: "Duplicate name within this file",
  DUPLICATE_ITEM_NUMBER_IN_FILE: "Duplicate item number within this file",
  EXISTING_ITEM_NUMBER: "Item number already in use",
  POSSIBLE_DUPLICATE: "Possible duplicate of an existing item",
};
