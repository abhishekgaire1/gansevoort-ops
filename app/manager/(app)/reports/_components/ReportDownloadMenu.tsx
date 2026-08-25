"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportExportFormat, ReportExportType } from "@/app/lib/reports/export/reportExportModel";
import { fetchReportExport } from "../_lib/reportDownload";

const FORMAT_LABEL: Record<ReportExportFormat, string> = { xlsx: "Excel (.xlsx)", csv: "CSV (.csv)", pdf: "PDF (.pdf)" };
const PREPARING_LABEL: Record<ReportExportFormat, string> = { xlsx: "Preparing Excel…", csv: "Preparing CSV…", pdf: "Preparing PDF…" };

/**
 * Shared Report Export Foundation (Section 1/16) -- the ONE "[ Download
 * ▾ ]" control every report page renders via PageHeader's `action` slot,
 * so Download never becomes each page's primary action. Hits the shared
 * export Route Handler (app/manager/(app)/reports/export/route.ts) with
 * the SAME filter/period query params the page itself is currently
 * showing -- the download always matches exactly what's on screen
 * (Section 2).
 *
 * A failed export only shows a small inline message next to this
 * control (Section 15) -- it never touches the report content above it,
 * and never retries automatically.
 */
export function ReportDownloadMenu({ reportType, queryString }: { reportType: ReportExportType; queryString: string }) {
  const [open, setOpen] = useState(false);
  const [pendingFormat, setPendingFormat] = useState<ReportExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function handleDownload(format: ReportExportFormat) {
    if (pendingFormat) return; // ignore duplicate submission for whichever export is already in flight
    setOpen(false);
    setError(null);
    setPendingFormat(format);
    const result = await fetchReportExport(reportType, format, queryString);
    if (!result.ok) {
      setError("Could not generate the report. Try again.");
    } else {
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }
    setPendingFormat(null);
  }

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pendingFormat !== null}
        className="flex items-center gap-1.5 rounded-full border border-zinc-700 px-4 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
      >
        {pendingFormat ? PREPARING_LABEL[pendingFormat] : "Download"}
        {!pendingFormat ? <span aria-hidden="true">▾</span> : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-lg">
          {(Object.keys(FORMAT_LABEL) as ReportExportFormat[]).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => handleDownload(format)}
              className="block w-full px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
            >
              {FORMAT_LABEL[format]}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="mt-1 text-right text-[11px] text-red-400">{error}</p> : null}
    </div>
  );
}
