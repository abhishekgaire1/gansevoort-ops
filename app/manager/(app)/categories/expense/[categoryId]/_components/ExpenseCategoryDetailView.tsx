"use client";

import { useEffect, useRef, useState } from "react";
import { getManagerExpenseCategoryAction, type ManagerExpensePeriodKind } from "@/app/actions/managerCategories";
import type { ManagerExpenseCategorySummaryDetail, ManagerExpenseCategoryLine } from "@/app/lib/categories/managerExpenseCategories";
import { formatEstimatedCost } from "@/app/lib/format/currency";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const PERIOD_LABELS: Record<ManagerExpensePeriodKind, string> = {
  TODAY: "Today",
  SEVEN_DAYS: "7 Days",
  THIRTY_DAYS: "30 Days",
  CUSTOM: "Custom",
};

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

function todayLocalDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function ExpenseCategoryDetailView({
  categoryId,
  initialSummary,
  initialLines,
}: {
  categoryId: string;
  initialSummary: ManagerExpenseCategorySummaryDetail;
  initialLines: ManagerExpenseCategoryLine[];
}) {
  const [period, setPeriod] = useState<ManagerExpensePeriodKind>("TODAY");
  const [customStart, setCustomStart] = useState(todayLocalDateString());
  const [customEnd, setCustomEnd] = useState(todayLocalDateString());
  const [summary, setSummary] = useState(initialSummary);
  const [lines, setLines] = useState(initialLines);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyTrigger, setApplyTrigger] = useState(0);

  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getManagerExpenseCategoryAction(categoryId, period, period === "CUSTOM" ? customStart : undefined, period === "CUSTOM" ? customEnd : undefined).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("message" in result ? result.message : "Unable to load category expenses.");
        return;
      }
      setSummary(result.summary);
      setLines(result.lines);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, applyTrigger]);

  async function loadMore() {
    setLoading(true);
    const result = await getManagerExpenseCategoryAction(categoryId, period, period === "CUSTOM" ? customStart : undefined, period === "CUSTOM" ? customEnd : undefined, lines.length);
    setLoading(false);
    if (result.ok) setLines((prev) => [...prev, ...result.lines]);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1">
          {(["TODAY", "SEVEN_DAYS", "THIRTY_DAYS", "CUSTOM"] as ManagerExpensePeriodKind[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${period === p ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {period === "CUSTOM" ? (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Start Date
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              End Date
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <button type="button" onClick={() => setApplyTrigger((n) => n + 1)} className={secondaryButtonClass}>
              Apply
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => setApplyTrigger((n) => n + 1)} className={`mt-3 ${secondaryButtonClass}`}>
            Try Again
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Total Expenses</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">{formatEstimatedCost(summary.totalAmount)}</p>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Expense Lines</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">{summary.lineCount}</p>
            </div>
          </div>

          {summary.excludedCreditMemoCount > 0 ? (
            <p className="text-xs text-zinc-500">
              {summary.excludedCreditMemoCount} credit memo line{summary.excludedCreditMemoCount === 1 ? "" : "s"} in this period {summary.excludedCreditMemoCount === 1 ? "is" : "are"} not included -- credit
              accounting isn&apos;t supported yet.
            </p>
          ) : null}

          <section>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Expenses</p>
            {lines.length === 0 ? (
              <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
                <p className="text-sm text-zinc-500">No expenses were recorded in this category for the selected period.</p>
              </div>
            ) : (
              <div className="mt-3 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
                {lines.map((line) => (
                  <a key={line.lineId} href={`/manager/purchases/${line.documentId}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-zinc-800/50 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-100">{line.description ?? "—"}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">{line.vendorName ?? "Unknown vendor"}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-right">
                      <p className="text-sm font-medium text-zinc-100">{line.lineTotal !== null ? formatEstimatedCost(line.lineTotal) : "—"}</p>
                      <div className="text-xs text-zinc-500">
                        <p>{line.documentDate ? new Date(`${line.documentDate}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}</p>
                        <p className="text-amber-400">
                          {line.documentType ? DOCUMENT_TYPE_LABEL[line.documentType] ?? line.documentType : "Document"}
                          {line.documentNumber ? ` #${line.documentNumber}` : ""} →
                        </p>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
            {lines.length > 0 && lines.length >= summary.lineCount ? null : lines.length > 0 ? (
              <button type="button" disabled={loading} onClick={loadMore} className={`mt-3 ${secondaryButtonClass}`}>
                {loading ? "Loading…" : "Load More"}
              </button>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
