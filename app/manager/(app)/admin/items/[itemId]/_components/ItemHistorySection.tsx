import type { ItemHistoryEntry } from "@/app/lib/admin/itemHistory";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableRowClass, tableCellClass, tableCellMutedClass } from "@/app/components/manager/surfaces";

const ACTION_LABELS: Record<string, string> = {
  CANONICAL_ITEM_CREATED: "Item created",
  CANONICAL_ITEM_RENAMED: "Renamed",
  CANONICAL_ITEM_UPDATED: "Updated",
  CANONICAL_ITEM_DEACTIVATED: "Archived",
  CANONICAL_ITEM_REACTIVATED: "Reactivated",
  VENDOR_PACKAGE_UPDATED: "Vendor package edited",
  VENDOR_PACKAGE_CONFIGURED: "Vendor package configured",
  INVENTORY_ADJUSTED: "Inventory adjusted",
  RECEIPT_PACKAGE_FACTOR_CORRECTED: "Receipt package factor corrected",
};

/**
 * Item workspace History (spec section 3/17) -- every edit, vendor-
 * package change, usage-unit change, inventory correction, and archive/
 * reactivation event, newest first, with acting manager/timestamp/
 * reason/before-after -- so this is understandable to a manager, not a
 * raw audit dump.
 */
export function ItemHistorySection({ entries }: { entries: ItemHistoryEntry[] }) {
  return (
    <div className={panelClass}>
      <div className={panelHeaderClass}>
        <p className={panelTitleClass}>History</p>
      </div>
      {entries.length === 0 ? (
        <div className={panelBodyClass}>
          <p className="text-sm text-zinc-500">No history yet.</p>
        </div>
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={tableHeadClass}>
              <tr>
                <th className={tableHeadCellClass}>When</th>
                <th className={tableHeadCellClass}>Action</th>
                <th className={tableHeadCellClass}>By</th>
                <th className={tableHeadCellClass}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={tableRowClass}>
                  <td className={tableCellMutedClass}>{new Date(e.occurredAt).toLocaleString()}</td>
                  <td className={tableCellClass}>{ACTION_LABELS[e.action] ?? e.action}</td>
                  <td className={tableCellClass}>{e.actorName ?? "System"}</td>
                  <td className={tableCellMutedClass}>
                    {e.reason ? <p>{e.reason}</p> : null}
                    {e.beforeState || e.afterState ? (
                      <p className="mt-0.5">
                        {e.beforeState ? JSON.stringify(e.beforeState) : ""} {e.afterState ? `→ ${JSON.stringify(e.afterState)}` : ""}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
