import Link from "next/link";
import { REPORT_PERIOD_OPTIONS, type ReportPeriodKey, type ResolvedReportPeriod } from "../_lib/reportPeriod";

function formatShortDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * V1 Reports closeout -- the ONE shared date-range control (Today/7
 * Days/30 Days/Custom) for every Reports page. Bug fix: before this,
 * only the Purchasing page actually rendered the Custom from/to date
 * inputs; Overview/Usage/Waste/Receiving all rendered the "Custom" pill
 * with no way to ever supply a date, so clicking it silently fell back
 * to Today with zero feedback. Every report now renders identically
 * (Reports Shared UX: "do not independently reinvent filter UX on every
 * report").
 *
 * `buildHref` lets each page preserve its OWN other filters (vendor/
 * category/location/etc.) when switching periods, without this
 * component needing to know what they are.
 */
export function ReportPeriodControl({
  period,
  customFrom,
  customTo,
  buildHref,
  extraHiddenFields,
}: {
  period: ResolvedReportPeriod;
  customFrom: string | undefined;
  customTo: string | undefined;
  buildHref: (key: ReportPeriodKey) => string;
  /** Any OTHER filters this page needs preserved as hidden fields when the
   * Custom date form itself is submitted (e.g. vendor/category/location). */
  extraHiddenFields?: Record<string, string | null | undefined>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {REPORT_PERIOD_OPTIONS.map((opt) => (
          <Link
            key={opt.key}
            href={buildHref(opt.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${period.key === opt.key ? "bg-zinc-100 text-zinc-950" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {opt.label}
          </Link>
        ))}
        {period.key === "CUSTOM" ? (
          <form method="get" className="flex items-end gap-2">
            <input type="hidden" name="period" value="CUSTOM" />
            {Object.entries(extraHiddenFields ?? {}).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              From
              <input type="date" name="from" defaultValue={customFrom ?? period.startDate} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              To
              <input type="date" name="to" defaultValue={customTo ?? period.endDate} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50" />
            </label>
            <button type="submit" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200">
              Apply
            </button>
          </form>
        ) : null}
        <span className="text-xs text-zinc-500">
          {formatShortDate(period.startDate)} – {formatShortDate(period.endDate)}
        </span>
      </div>
      {period.customError ? <p className="text-xs text-red-400">Invalid custom date range -- showing Today instead.</p> : null}
    </div>
  );
}
