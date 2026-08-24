/**
 * Activity type filter constants (Inventory Item Detail + Activity
 * History milestone) -- deliberately in their own client-safe module, no
 * "server-only" transitive dependency, matching wasteReasons.ts's own
 * documented reasoning: itemActivity.ts (the RPC wrapper layer) has a
 * server-only dependency chain (cycleCounts.ts -> "server-only"), so a
 * "use client" component importing this runtime value directly from
 * itemActivity.ts would pull that whole chain into the client bundle and
 * fail the build. Types from itemActivity.ts remain safe to import
 * (import type is erased at compile time), but this is a runtime value,
 * so it lives here instead.
 */
import type { InventoryMovementType } from "@/app/lib/inventory/activityTypes";

export const ACTIVITY_TYPE_FILTERS = ["ALL", "RECEIVED", "WITHDRAWALS", "WASTE", "CYCLE_COUNTS"] as const;
export type ActivityTypeFilter = (typeof ACTIVITY_TYPE_FILTERS)[number];

/** Maps a UI filter selection to the actual movement_type enum values it
 * covers -- "Cycle Counts" genuinely means two enum values (IN and OUT
 * variance), never a new combined enum. Null means no filter. Shared by
 * both the item-scoped and global Activity read models -- one filter
 * vocabulary, never two. */
export function movementTypesForFilter(filter: ActivityTypeFilter): InventoryMovementType[] | null {
  switch (filter) {
    case "RECEIVED":
      return ["PURCHASE_RECEIPT"];
    case "WITHDRAWALS":
      return ["ISSUE_TO_STATION"];
    case "WASTE":
      return ["WASTE"];
    case "CYCLE_COUNTS":
      return ["COUNT_ADJUSTMENT_IN", "COUNT_ADJUSTMENT_OUT"];
    case "ALL":
    default:
      return null;
  }
}
