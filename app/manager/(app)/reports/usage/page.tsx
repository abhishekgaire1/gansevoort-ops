import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getUsageReportAction, getReportsTimezone } from "@/app/actions/reports";
import { resolveReportPeriod, type ReportPeriodKey } from "../_lib/reportPeriod";
import { ReportPeriodControl } from "../_components/ReportPeriodControl";
import { ReportRetryButton } from "../_components/ReportRetryButton";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved || undefined;
}

/** V1 Reports foundation -- Inventory Usage report (Section 32). This is
 * WITHDRAWALS TO STATIONS, never "consumption"/"sales usage" -- V1 has no
 * Sales data. Quantities are only ever shown per item + its own base
 * unit, never summed across incompatible units into one org-wide number. */
export default async function UsageReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // See app/manager/(app)/reports/waste/page.tsx for why this throws
    // instead of returning null (Reports blank-screen crash fix).
    throw new Error("Not authorized to view this report.");
  }

  const params = await searchParams;
  const periodKey = firstValue(params.period);
  const customFrom = firstValue(params.from);
  const customTo = firstValue(params.to);

  const timezoneResult = await getReportsTimezone();
  const timeZone = timezoneResult.ok ? timezoneResult.timeZone : "America/New_York";
  const period = resolveReportPeriod(new Date(), timeZone, periodKey, customFrom, customTo);

  const isAdmin = auth.manager.roles.includes("admin");
  const reportResult = await getUsageReportAction(period.startDate, period.endDate);
  const report = reportResult.ok ? reportResult.report : null;

  function periodHref(key: ReportPeriodKey): string {
    return `/manager/reports/usage?period=${key}`;
  }

  return (
    <div>
      <PageHeader title="Inventory Usage" description="Withdrawals to stations -- not consumption or sales usage (V1 has no Sales data)." />

      <div className="mt-4">
        <ReportPeriodControl period={period} customFrom={customFrom} customTo={customTo} buildHref={periodHref} />
      </div>

      {!report ? (
        <div className="mt-6">
          <EmptyState message="Could not load the usage report." action={<ReportRetryButton />} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs text-zinc-500">Withdrawal Movements</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100">{report.movementCount}</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">By Item</p>
              {report.byItem.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No withdrawals in this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byItem.map((row) => (
                    <Link key={row.itemId} href={`/manager/inventory/items/${row.itemId}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50">
                      <span className="truncate text-zinc-300">{row.itemName}</span>
                      <span className="shrink-0 text-zinc-100">
                        {row.quantity} {row.baseUnitCode}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">By Station</p>
              {report.byStation.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No withdrawals in this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byStation.map((row) => {
                    const content = (
                      <>
                        <span className="text-zinc-300">{row.stationName}</span>
                        <span className="text-zinc-100">{row.movementCount}</span>
                      </>
                    );
                    // Station detail is Admin-only -- no Manager-visible
                    // station page exists yet, so this only links for an
                    // admin viewer (same treatment as Purchasing's vendor
                    // drill-down).
                    return isAdmin && row.stationId ? (
                      <Link key={row.stationId} href={`/manager/admin/stations/${row.stationId}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50">
                        {content}
                      </Link>
                    ) : (
                      <div key={row.stationId ?? "unknown"} className="flex items-center justify-between gap-2 py-2 text-sm">
                        {content}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
