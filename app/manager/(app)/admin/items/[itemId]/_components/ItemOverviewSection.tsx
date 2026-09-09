import type { ItemWorkspaceOverview } from "@/app/lib/admin/itemWorkspace";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass } from "@/app/components/manager/surfaces";

/**
 * Item workspace Overview (spec section 3) -- name/code/disposition/
 * categories/base unit/active status/current on-hand quantity by
 * location/current inventory value/updated-at, all read-only here
 * (editing lives in Edit Item / Adjust Inventory / the vendor-package and
 * usage-unit sections below, each with their own impact-appropriate
 * flow -- Overview itself never mutates anything).
 */
export function ItemOverviewSection({ overview, actorSummary }: { overview: ItemWorkspaceOverview; actorSummary: string | null }) {
  const { item, totalOnHandQuantity, locationBalances, estimatedTotalValue, estimatedUnitCost } = overview;

  return (
    <div className={panelClass}>
      <div className={panelHeaderClass}>
        <p className={panelTitleClass}>Overview</p>
      </div>
      <div className={`${panelBodyClass} grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3`}>
        <Field label="Disposition" value={item.disposition === "INVENTORY" ? "Inventory" : "Expense"} />
        <Field label="Inventory category" value={item.categoryName ?? "—"} />
        <Field label="Spend category" value={item.spendCategoryName ?? "—"} />
        <Field label="Base unit" value={item.baseUnitCode ?? "—"} />
        <Field label="Default receiving location" value={item.defaultReceivingLocationName ?? "Not set"} />
        <Field label="Last updated" value={`${new Date(item.updatedAt).toLocaleString()}${actorSummary ? ` · ${actorSummary}` : ""}`} />
      </div>
      <div className={`${panelBodyClass} border-t border-zinc-800`}>
        <p className={panelMetaClass}>Current on-hand quantity</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">
          {totalOnHandQuantity} <span className="text-sm font-normal text-zinc-500">{item.baseUnitCode}</span>
        </p>
        {locationBalances.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1">
            {locationBalances.map((l) => (
              <div key={l.locationId} className="flex items-center justify-between text-sm">
                <span className="text-zinc-400">{l.locationName}</span>
                <span className="tabular-nums text-zinc-200">
                  {l.balance} {item.baseUnitCode}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No stock at any location.</p>
        )}
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <p className={panelMetaClass}>Current inventory value (operational estimate)</p>
          {estimatedTotalValue !== null ? (
            <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">
              ${estimatedTotalValue.toFixed(2)}{" "}
              <span className="text-xs font-normal text-zinc-500">(${estimatedUnitCost?.toFixed(4)} / {item.baseUnitCode})</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">No verified cost yet.</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-600">
            An operational estimate from weighted-average verified purchase cost -- never an accounting inventory valuation, landed cost, or COGS.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={panelMetaClass}>{label}</p>
      <p className="mt-0.5 text-sm text-zinc-200">{value}</p>
    </div>
  );
}
