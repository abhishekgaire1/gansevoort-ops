import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getPurchasingReportAction, getPurchasingReportPriceChangesAction, getReportsTimezone } from "@/app/actions/reports";
import { listVendors } from "@/app/actions/vendors";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { resolveReportPeriod, type ReportPeriodKey } from "../_lib/reportPeriod";
import { buildExportQueryString } from "../_lib/exportQueryString";
import { ReportPeriodControl } from "../_components/ReportPeriodControl";
import { ReportRetryButton } from "../_components/ReportRetryButton";
import { ReportDownloadMenu } from "../_components/ReportDownloadMenu";
import { priceChangeTone } from "@/app/lib/purchasing/priceChangePresentation";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";

export const dynamic = "force-dynamic";

/**
 * V1 Reports foundation -- Purchasing (Section 29/30/31). The main V1
 * purchasing insight page: total purchase value + document/vendor/item
 * counts, breakdowns by vendor/category/item, and Price Changes folded in
 * here rather than as a separate sidebar destination (Section 27's own
 * "you may simplify these... include Price Changes inside Purchasing").
 * Every number comes from get_purchasing_report /
 * get_purchasing_report_price_changes (20260811100108) -- one round trip
 * each, server-aggregated, never raw rows fetched to the browser.
 */

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved || undefined;
}

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default async function PurchasingReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const categoryId = firstValue(params.category) ?? null;

  const timezoneResult = await getReportsTimezone();
  const timeZone = timezoneResult.ok ? timezoneResult.timeZone : "America/New_York";
  const period = resolveReportPeriod(new Date(), timeZone, periodKey, customFrom, customTo);

  const isAdmin = auth.manager.roles.includes("admin");

  const [reportResult, priceChangesResult, vendorsResult, categoriesResult] = await Promise.all([
    getPurchasingReportAction(period.startDate, period.endDate, { vendorId, inventoryCategoryId: categoryId }),
    getPurchasingReportPriceChangesAction(period.startDate, period.endDate, vendorId, categoryId),
    listVendors(),
    listInventoryCategories(),
  ]);

  const report = reportResult.ok ? reportResult.report : null;
  const priceChanges = priceChangesResult.ok ? priceChangesResult.changes : { increases: [], decreases: [] };
  const vendors = vendorsResult.ok ? vendorsResult.vendors : [];
  const categories = categoriesResult.ok ? categoriesResult.categories : [];

  function periodHref(key: ReportPeriodKey): string {
    const p = new URLSearchParams();
    p.set("period", key);
    if (vendorId) p.set("vendor", vendorId);
    if (categoryId) p.set("category", categoryId);
    return `/manager/reports/purchasing?${p.toString()}`;
  }

  return (
    <div>
      <PageHeader
        title="Purchasing"
        description="Total purchase value, vendor/category/item breakdowns, and recent price changes -- from verified purchase documents only."
        action={<ReportDownloadMenu reportType="purchasing" queryString={buildExportQueryString(period, { vendor: vendorId, category: categoryId })} />}
      />

      <div className="mt-4">
        <ReportPeriodControl
          period={period}
          customFrom={customFrom}
          customTo={customTo}
          buildHref={periodHref}
          extraHiddenFields={{ vendor: vendorId, category: categoryId }}
        />
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
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Inventory Category
          <select name="category" defaultValue={categoryId ?? ""} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50">
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-full bg-zinc-100 px-4 py-1.5 text-xs font-semibold text-zinc-950">
          Apply
        </button>
        {vendorId || categoryId ? (
          <Link href={periodHref(period.key)} className="text-xs text-zinc-500 underline">
            Clear Filters
          </Link>
        ) : null}
      </form>

      {!report ? (
        <div className="mt-6">
          <EmptyState message="Could not load the purchasing report." action={<ReportRetryButton />} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label="Total Purchase Value" value={formatMoney(report.totalPurchaseValue)} />
            <SummaryCard label="Documents" value={String(report.documentCount)} />
            <SummaryCard label="Vendors" value={String(report.vendorCount)} />
            <SummaryCard label="Items Purchased" value={String(report.itemCount)} />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Vendor detail is Admin-only (app/manager/admin/vendors/[vendorId]) --
                no Manager-visible vendor page exists yet, so this only links for
                an admin viewer; a Manager sees the same row, just unlinked,
                rather than a dead-end 403. */}
            <BreakdownTable title="Purchase by Vendor" rows={report.byVendor} linkHref={isAdmin ? (id) => `/manager/admin/vendors/${id}` : undefined} />
            <BreakdownTable title="Purchase by Category" rows={report.byCategory} linkHref={(id) => `/manager/categories/inventory/${id}`} />
            <BreakdownTable
              title="Purchase by Item"
              rows={report.byItem}
              linkHref={(id) => `/manager/inventory/items/${id}`}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <PriceChangeTable title="Largest Recent Increases" rows={priceChanges.increases} tone="increase" />
            <PriceChangeTable title="Largest Recent Decreases" rows={priceChanges.decreases} tone="decrease" />
          </div>
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

function BreakdownTable({
  title,
  rows,
  linkHref,
}: {
  title: string;
  rows: { id: string | null; name: string; totalValue: number }[];
  linkHref?: (id: string) => string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-600">No data for this period.</p>
      ) : (
        <div className="mt-2 flex flex-col divide-y divide-zinc-800">
          {rows.map((row) => {
            const content = (
              <>
                <span className="truncate text-zinc-300">{row.name}</span>
                <span className="shrink-0 text-zinc-100">{formatMoney(row.totalValue)}</span>
              </>
            );
            return row.id && linkHref ? (
              <Link key={row.id ?? row.name} href={linkHref(row.id)} className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50">
                {content}
              </Link>
            ) : (
              <div key={row.id ?? row.name} className="flex items-center justify-between gap-2 py-2 text-sm">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PriceChangeTable({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: {
    itemId: string;
    itemName: string;
    vendorName: string;
    baseUnitCode: string;
    currentUnitCost: number;
    previousUnitCost: number;
    deltaPct: number;
    currentDocumentDate: string | null;
  }[];
  tone: "increase" | "decrease";
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-600">No price changes in this period.</p>
      ) : (
        <div className="mt-2 flex flex-col divide-y divide-zinc-800">
          {rows.map((row) => (
            <Link
              key={`${row.itemId}-${row.vendorName}`}
              href={`/manager/inventory/items/${row.itemId}`}
              className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-zinc-300">{row.itemName}</span>
                <span className="block text-[11px] text-zinc-600">{row.vendorName}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-zinc-100">
                  ${row.currentUnitCost.toFixed(2)} / {row.baseUnitCode}
                </span>
                <span className={`block text-[11px] font-medium ${priceChangeTone(tone).colorClass}`}>
                  {priceChangeTone(tone).glyph} {Math.abs(row.deltaPct).toFixed(1)}%
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
