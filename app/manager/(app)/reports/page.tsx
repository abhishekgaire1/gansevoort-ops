import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getPurchasingReportAction, getReceivingReportAction, getUsageReportAction, getWasteReportAction, getInventoryStatusReportAction, getReportsTimezone } from "@/app/actions/reports";
import { resolveReportPeriod, type ReportPeriodKey } from "./_lib/reportPeriod";
import { buildExportQueryString } from "./_lib/exportQueryString";
import { ReportPeriodControl } from "./_components/ReportPeriodControl";
import { ReportDownloadMenu } from "./_components/ReportDownloadMenu";
import { PageHeader } from "@/app/components/manager/PageHeader";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved || undefined;
}

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/**
 * V1 Reports foundation -- Overview (Section 28). Operational summary
 * only, composed entirely from the same server-aggregated RPCs the
 * dedicated report pages use -- never a separate/duplicated computation.
 * Inventory Status is deliberately NOT date-ranged (current balances are
 * a point-in-time truth); every other card reflects the selected period.
 * No revenue/profit, no incompatible-unit totals.
 */
export default async function ReportsOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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

  const [purchasing, receiving, usage, waste, inventoryStatus] = await Promise.all([
    getPurchasingReportAction(period.startDate, period.endDate),
    getReceivingReportAction(period.startDate, period.endDate),
    getUsageReportAction(period.startDate, period.endDate),
    getWasteReportAction(period.startDate, period.endDate),
    getInventoryStatusReportAction(),
  ]);

  function periodHref(key: ReportPeriodKey): string {
    return `/manager/reports?period=${key}`;
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Operational summary across Receiving and Inventory -- deeper detail lives on each dedicated report."
        action={<ReportDownloadMenu reportType="overview" queryString={buildExportQueryString(period)} />}
      />

      <div className="mt-4">
        <ReportPeriodControl period={period} customFrom={customFrom} customTo={customTo} buildHref={periodHref} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard href="/manager/reports/purchasing" title="Purchasing">
          <Metric label="Purchase Value" value={purchasing.ok ? formatMoney(purchasing.report.totalPurchaseValue) : "—"} />
          <Metric label="Documents" value={purchasing.ok ? String(purchasing.report.documentCount) : "—"} />
        </OverviewCard>

        <OverviewCard href="/manager/reports/receiving" title="Receiving">
          <Metric label="Documents Processed" value={receiving.ok ? String(receiving.report.documentCount) : "—"} />
          <Metric label="Ready to Post" value={receiving.ok ? String(receiving.report.readyToPostCount) : "—"} />
          <Metric label="Partially Posted" value={receiving.ok ? String(receiving.report.partiallyPostedCount) : "—"} />
        </OverviewCard>

        <OverviewCard href="/manager/reports/inventory-status" title="Inventory">
          <Metric label="Low Stock" value={inventoryStatus.ok ? String(inventoryStatus.report.lowStockCount) : "—"} />
          <Metric label="Out of Stock" value={inventoryStatus.ok ? String(inventoryStatus.report.outOfStockCount) : "—"} />
        </OverviewCard>

        <OverviewCard href="/manager/reports/usage" title="Usage">
          <Metric label="Withdrawal Movements" value={usage.ok ? String(usage.report.movementCount) : "—"} />
        </OverviewCard>

        <OverviewCard href="/manager/reports/waste" title="Waste">
          <Metric label="Waste Events" value={waste.ok ? String(waste.report.eventCount) : "—"} />
        </OverviewCard>
      </div>
    </div>
  );
}

function OverviewCard({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded-2xl border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-100">{value}</span>
    </div>
  );
}
