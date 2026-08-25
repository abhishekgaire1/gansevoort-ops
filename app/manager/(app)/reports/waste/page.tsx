import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getWasteReportAction, getReportsTimezone } from "@/app/actions/reports";
import { listActivityLocationsAction } from "@/app/actions/inventoryActivity";
import { resolveReportPeriod, type ReportPeriodKey } from "../_lib/reportPeriod";
import { buildExportQueryString } from "../_lib/exportQueryString";
import { ReportPeriodControl } from "../_components/ReportPeriodControl";
import { ReportRetryButton } from "../_components/ReportRetryButton";
import { ReportDownloadMenu } from "../_components/ReportDownloadMenu";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { WASTE_REASON_LABEL as REASON_LABEL } from "@/app/lib/reports/wasteReasonLabels";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved || undefined;
}

/** V1 Reports foundation -- Waste report (Section 34). Tracked-storage
 * Inventory Waste only -- no station/prep/end-day waste (not modeled in
 * V1), no theoretical waste. */
export default async function WasteReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // Bug fix (Reports blank-screen crash): this is a SEPARATE auth
    // resolution from the (app) layout's own -- the layout already
    // redirects on a genuine, persistent auth failure, so reaching here
    // means this specific call transiently failed (the already-diagnosed
    // auth-resolution race under concurrent report navigation) while the
    // Manager's real session is fine. Throwing (not `return null`) lets
    // the shared Reports error.tsx show a recoverable state instead of a
    // silent blank content area with the shell still visible.
    throw new Error("Not authorized to view this report.");
  }

  const params = await searchParams;
  const periodKey = firstValue(params.period);
  const customFrom = firstValue(params.from);
  const customTo = firstValue(params.to);
  const locationId = firstValue(params.location) ?? null;

  const timezoneResult = await getReportsTimezone();
  const timeZone = timezoneResult.ok ? timezoneResult.timeZone : "America/New_York";
  const period = resolveReportPeriod(new Date(), timeZone, periodKey, customFrom, customTo);

  const [reportResult, locationsResult] = await Promise.all([
    getWasteReportAction(period.startDate, period.endDate, { locationId }),
    listActivityLocationsAction(),
  ]);
  const report = reportResult.ok ? reportResult.report : null;
  const locations = locationsResult.ok ? locationsResult.locations : [];

  function periodHref(key: ReportPeriodKey): string {
    const p = new URLSearchParams();
    p.set("period", key);
    if (locationId) p.set("location", locationId);
    return `/manager/reports/waste?${p.toString()}`;
  }

  return (
    <div>
      <PageHeader
        title="Waste"
        description="Tracked-storage inventory waste only -- events and quantity by item and reason."
        action={<ReportDownloadMenu reportType="waste" queryString={buildExportQueryString(period, { location: locationId })} />}
      />

      <div className="mt-4">
        <ReportPeriodControl period={period} customFrom={customFrom} customTo={customTo} buildHref={periodHref} extraHiddenFields={{ location: locationId }} />
      </div>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="period" value={period.key} />
        {period.key === "CUSTOM" ? (
          <>
            <input type="hidden" name="from" value={period.startDate} />
            <input type="hidden" name="to" value={period.endDate} />
          </>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Location
          <select name="location" defaultValue={locationId ?? ""} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50">
            <option value="">All</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-full bg-zinc-100 px-4 py-1.5 text-xs font-semibold text-zinc-950">
          Apply
        </button>
      </form>

      {!report ? (
        <div className="mt-6">
          <EmptyState message="Could not load the waste report." action={<ReportRetryButton />} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs text-zinc-500">Waste Events</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100">{report.eventCount}</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Quantity by Item</p>
              {report.byItem.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No waste recorded for this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byItem.map((row) => (
                    <Link key={row.itemId} href={`/manager/inventory/items/${row.itemId}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50">
                      <span className="truncate text-zinc-300">{row.itemName}</span>
                      <span className="shrink-0 text-zinc-100">
                        {row.quantity} {row.unitCode}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Events by Reason</p>
              {report.byReason.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No waste recorded for this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byReason.map((row) => (
                    <div key={row.reasonCode} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="text-zinc-300">{REASON_LABEL[row.reasonCode] ?? row.reasonCode}</span>
                      <span className="text-zinc-100">{row.eventCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
