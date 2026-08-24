"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseSpreadsheet, validateRows, ROW_ISSUE_LABEL, type ValidatedRow } from "@/app/lib/admin/bulkImportParse";
import { listAllAdminItemKeysAction, bulkImportAdminItemsAction } from "@/app/actions/adminItems";
import type { BulkImportRowResult } from "@/app/lib/admin/items";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

function normalizeName(name: string): string {
  return name.toUpperCase().trim().replace(/\s+/g, " ");
}

export function BulkImportView({ categories, units }: { categories: CategorySummary[]; units: { id: string; code: string; name: string }[] }) {
  const router = useRouter();
  const [filename, setFilename] = useState<string | null>(null);
  const [rows, setRows] = useState<ValidatedRow[] | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<BulkImportRowResult[] | null>(null);
  const submittingRef = useRef(false);

  async function handleFileSelected(file: File) {
    setParsing(true);
    setParseError(null);
    setResults(null);
    setRows(null);
    setFilename(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseSpreadsheet(buffer);
      if (parsed.length === 0) {
        setParseError("No rows were found in this file.");
        setParsing(false);
        return;
      }

      const existingResult = await listAllAdminItemKeysAction();
      if (!existingResult.ok) {
        setParseError(existingResult.message);
        setParsing(false);
        return;
      }

      const existingNumbers = new Set(existingResult.items.map((i) => i.itemNumber));
      const existingByName = new Map(existingResult.items.map((i) => [normalizeName(i.name), { id: i.itemId, name: i.name, itemNumber: i.itemNumber }]));

      const validated = validateRows(parsed, categories, units, existingNumbers, existingByName);
      setRows(validated);
    } catch {
      setParseError("Unable to parse this file. Confirm it's a valid CSV or XLSX export.");
    } finally {
      setParsing(false);
    }
  }

  async function handleImport() {
    if (submittingRef.current || !rows) return;
    submittingRef.current = true;
    setImporting(true);
    try {
      const toImport = rows.filter((r) => r.severity === "ready" || (includeDuplicates && r.severity === "needs_review"));
      const result = await bulkImportAdminItemsAction(
        filename,
        toImport.map((r) => ({
          rowIndex: r.rowIndex,
          itemNumber: r.itemNumber,
          name: r.name,
          categoryId: r.categoryId,
          baseUnitId: r.baseUnitId,
          status: r.status,
        }))
      );
      if (!result.ok) {
        setParseError("message" in result ? result.message : "Import failed.");
        return;
      }
      setResults(result.results);
      router.refresh();
    } finally {
      setImporting(false);
      submittingRef.current = false;
    }
  }

  const readyCount = rows?.filter((r) => r.severity === "ready").length ?? 0;
  const needsReviewCount = rows?.filter((r) => r.severity === "needs_review").length ?? 0;
  const invalidCount = rows?.filter((r) => r.severity === "invalid").length ?? 0;
  const importCount = readyCount + (includeDuplicates ? needsReviewCount : 0);

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="flex flex-col gap-2 text-sm text-zinc-300">
          Upload CSV or XLSX
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
            }}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 file:mr-3 file:rounded-full file:border-0 file:bg-amber-400 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-zinc-950"
          />
        </label>
        <p className="mt-2 text-xs text-zinc-600">Required columns: Item Number (optional), Canonical Name, Category, Base Unit. Optional: Status.</p>
      </div>

      {parsing ? <p className="text-sm text-zinc-500">Parsing…</p> : null}
      {parseError ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{parseError}</p>
        </div>
      ) : null}

      {rows && !results ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-300">{rows.length} rows detected</p>
            <div className="mt-2 flex gap-4 text-sm">
              <span className="text-emerald-400">{readyCount} Ready</span>
              <span className="text-amber-400">{needsReviewCount} Possible Duplicates</span>
              <span className="text-red-400">{invalidCount} Invalid</span>
            </div>
            {needsReviewCount > 0 ? (
              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={includeDuplicates} onChange={(e) => setIncludeDuplicates(e.target.checked)} className="h-4 w-4" />
                Also import possible duplicates
              </label>
            ) : null}
          </div>

          {rows.some((r) => r.issues.length > 0) ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Issues</p>
              <div className="mt-3 flex flex-col divide-y divide-zinc-800">
                {rows
                  .filter((r) => r.issues.length > 0)
                  .map((r) => (
                    <div key={r.rowIndex} className="py-2 text-sm">
                      <p className="text-zinc-200">
                        Row {r.rowIndex}
                        {r.name ? ` — ${r.name}` : ""}
                      </p>
                      <ul className="mt-1 list-inside list-disc text-xs text-zinc-500">
                        {r.issues.map((issue) => (
                          <li key={issue}>{ROW_ISSUE_LABEL[issue]}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              disabled={importing}
              onClick={() => {
                setRows(null);
                setFilename(null);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="button" disabled={importing || importCount === 0} onClick={handleImport} className={primaryButtonClass}>
              {importing ? "Importing…" : `Import ${importCount} Item${importCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ) : null}

      {results ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-sm text-zinc-300">
            {results.filter((r) => r.outcome === "IMPORTED").length} imported · {results.filter((r) => r.outcome === "DUPLICATE_SKIPPED").length} skipped as duplicates ·{" "}
            {results.filter((r) => r.outcome === "REJECTED").length} rejected
          </p>
          {results.some((r) => r.outcome !== "IMPORTED") ? (
            <div className="mt-3 flex flex-col divide-y divide-zinc-800">
              {results
                .filter((r) => r.outcome !== "IMPORTED")
                .map((r) => (
                  <div key={r.rowIndex} className="py-2 text-sm text-zinc-400">
                    Row {r.rowIndex}: {r.message}
                  </div>
                ))}
            </div>
          ) : null}
          <Link href="/manager/admin/items" className={`mt-4 inline-block ${primaryButtonClass}`}>
            View Item Master
          </Link>
        </div>
      ) : null}
    </div>
  );
}
