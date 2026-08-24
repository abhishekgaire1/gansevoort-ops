import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getReceivingReportAction, getReportsTimezone } from "@/app/actions/reports";
import { listVendors } from "@/app/actions/vendors";
import { receivingStatusPresentation } from "../../receiving/_lib/receivingPresentation";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
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

/** V1 Reports foundation -- Receiving report (Section 35). Document
 * counts by status/vendor, credit-line visibility, and the same posting-
 * status derivation the Receiving Queue itself uses. */
export default async function ReceivingReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const vendorId = firstValue(params.vendor) ?? null;

  const timezoneResult = await getReportsTimezone();
  const timeZone = timezoneResult.ok ? timezoneResult.timeZone : "America/New_York";
  const period = resolveReportPeriod(new Date(), timeZone, periodKey, customFrom, customTo);

  const isAdmin = auth.manager.roles.includes("admin");
  const [reportResult, vendorsResult] = await Promise.all([getReceivingReportAction(period.startDate, period.endDate, vendorId), listVendors()]);
  const report = reportResult.ok ? reportResult.report : null;
  const vendors = vendorsResult.ok ? vendorsResult.vendors : [];

  function periodHref(key: ReportPeriodKey): string {
    const p = new URLSearchParams();
    p.set("period", key);
    if (vendorId) p.set("vendor", vendorId);
    return `/manager/reports/receiving?${p.toString()}`;
  }

  return (
    <div>
      <PageHeader title="Receiving" description="Documents received, by vendor and status, credits, and posting progress." />

      <div className="mt-4">
        <ReportPeriodControl period={period} customFrom={customFrom} customTo={customTo} buildHref={periodHref} extraHiddenFields={{ vendor: vendorId }} />
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
          Vendor
          <select name="vendor" defaultValue={vendorId ?? ""} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50">
            <option value="">All</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
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
          <EmptyState message="Could not load the receiving report." action={<ReportRetryButton />} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <SummaryCard label="Documents" value={String(report.documentCount)} />
            <SummaryCard label="Ready to Post" value={String(report.readyToPostCount)} />
            <SummaryCard label="Partially Posted" value={String(report.partiallyPostedCount)} />
            <SummaryCard label="Posted" value={String(report.postedCount)} />
            <SummaryCard label="Credit Lines" value={String(report.creditLineCount)} />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">By Status</p>
              {report.byStatus.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No documents for this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byStatus.map((row) => (
                    <Link
                      key={row.status}
                      href={`/manager/receiving?status=${row.status}`}
                      className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50"
                    >
                      <span className="text-zinc-300">{receivingStatusPresentation(row.status as ReceivingItemStatus).label}</span>
                      <span className="text-zinc-100">{row.count}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">By Vendor</p>
              {report.byVendor.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">No documents for this period.</p>
              ) : (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                  {report.byVendor.map((row) => {
                    const content = (
                      <>
                        <span className="truncate text-zinc-300">{row.vendorName}</span>
                        <span className="text-zinc-100">{row.count}</span>
                      </>
                    );
                    // Vendor detail is Admin-only -- same treatment as
                    // Purchasing's vendor drill-down.
                    return isAdmin ? (
                      <Link key={row.vendorId} href={`/manager/admin/vendors/${row.vendorId}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50">
                        {content}
                      </Link>
                    ) : (
                      <div key={row.vendorId} className="flex items-center justify-between gap-2 py-2 text-sm">
                        {content}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <p className="mt-4 text-xs text-zinc-600">
            <Link href="/manager/receiving" className="underline hover:text-zinc-400">
              Open the Receiving Queue →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-zinc-100">{value}</p>
    </div>
  );
}
