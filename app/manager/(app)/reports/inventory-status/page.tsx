import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getInventoryStatusReportAction } from "@/app/actions/reports";
import { listActivityLocationsAction } from "@/app/actions/inventoryActivity";
import { ReportRetryButton } from "../_components/ReportRetryButton";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved || undefined;
}

/** V1 Reports foundation -- Inventory Status report (Section 33). Not
 * date-ranged -- current balances, the exact same authoritative truth
 * Current Inventory itself shows (list_inventory_balances +
 * computeStockGauge), just counted/filtered as Low Stock / Out of Stock.
 * No forecasting, no "days remaining" (no Sales/usage model to base it on). */
export default async function InventoryStatusReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // See app/manager/(app)/reports/waste/page.tsx for why this throws
    // instead of returning null (Reports blank-screen crash fix).
    throw new Error("Not authorized to view this report.");
  }

  const params = await searchParams;
  const locationId = firstValue(params.location) ?? null;

  const [reportResult, locationsResult] = await Promise.all([getInventoryStatusReportAction({ locationId }), listActivityLocationsAction()]);
  const report = reportResult.ok ? reportResult.report : null;
  const locations = locationsResult.ok ? locationsResult.locations : [];

  return (
    <div>
      <PageHeader title="Inventory Status" description="Current authoritative balances -- low stock and out-of-stock items." />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
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
          <EmptyState message="Could not load the inventory status report." action={<ReportRetryButton />} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-red-900/60 bg-red-950/10 p-4">
              <p className="text-xs text-red-400">Out of Stock</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100">{report.outOfStockCount}</p>
            </div>
            <div className="rounded-2xl border border-amber-900/60 bg-amber-950/10 p-4">
              <p className="text-xs text-amber-400">Low Stock</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100">{report.lowStockCount}</p>
            </div>
            <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/10 p-4">
              <p className="text-xs text-emerald-400">Healthy / Above Threshold</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100">{report.healthyCount}</p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Low &amp; Out of Stock Items</p>
            {report.rows.length === 0 ? (
              <p className="mt-3 text-xs text-zinc-600">Nothing is low or out of stock.</p>
            ) : (
              <div className="mt-2 flex flex-col divide-y divide-zinc-800">
                {report.rows.map((row) => (
                  <Link
                    key={`${row.inventoryItemId}-${row.locationId}`}
                    href={`/manager/inventory/items/${row.inventoryItemId}`}
                    className="flex items-center justify-between gap-2 py-2 text-sm hover:text-zinc-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-zinc-300">{row.itemName}</span>
                      <span className="block text-[11px] text-zinc-600">{row.locationName}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={`block text-xs font-medium ${row.stockLevel === "EMPTY" ? "text-red-400" : "text-amber-400"}`}>{row.stockLevel === "EMPTY" ? "Out of Stock" : "Low"}</span>
                      <span className="block text-[11px] text-zinc-500">
                        {row.balance} {row.baseUnitCode}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
