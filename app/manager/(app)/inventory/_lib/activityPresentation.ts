import type { InventoryActivityEntry, InventoryMovementType } from "@/app/lib/inventory/itemActivity";
import { WASTE_REASON_LABELS } from "@/app/lib/inventory/wasteReasons";

/**
 * Pure, framework-agnostic presentation helpers for the Inventory Item
 * Activity timeline (Inventory Item Detail + Activity History milestone)
 * -- kept separate from the rendering component and independently
 * unit-tested, matching this codebase's existing convention
 * (scanPreview.ts, receivingPresentation.ts, cycleCountDisplayItems.ts).
 */

const MOVEMENT_DISPLAY_LABEL: Record<InventoryMovementType, string> = {
  PURCHASE_RECEIPT: "Received",
  ISSUE_TO_STATION: "Withdrawal",
  WASTE: "Waste",
  COUNT_ADJUSTMENT_IN: "Cycle Count Adjustment",
  COUNT_ADJUSTMENT_OUT: "Cycle Count Adjustment",
  TRANSFER_IN: "Transfer In",
  TRANSFER_OUT: "Transfer Out",
};

/** Never expose the raw enum string (e.g. "COUNT_ADJUSTMENT_OUT")
 * directly to a manager. */
export function movementDisplayLabel(movementType: InventoryMovementType): string {
  return MOVEMENT_DISPLAY_LABEL[movementType] ?? movementType;
}

/** Cycle Count adjustments use a distinct two-way glyph regardless of
 * which specific direction this particular adjustment happened to be --
 * a count can reconcile either up or down, and the glyph communicates
 * "reconciliation," not this row's own sign (the signed quantity next to
 * it already communicates that). */
export function movementGlyph(movementType: InventoryMovementType): "↑" | "↓" | "↕" {
  if (movementType === "COUNT_ADJUSTMENT_IN" || movementType === "COUNT_ADJUSTMENT_OUT") return "↕";
  return IN_MOVEMENT_TYPES.has(movementType) ? "↑" : "↓";
}

const IN_MOVEMENT_TYPES = new Set<InventoryMovementType>(["PURCHASE_RECEIPT", "COUNT_ADJUSTMENT_IN", "TRANSFER_IN"]);

/** The verb preceding the actor's name -- precise about the role the
 * stored app_user id actually represents for that movement type (Part
 * "ACTOR LABELING"). Null for movement types with no established actor
 * verb (defensive-only types this app never actually writes yet). */
export function actorLabelVerb(movementType: InventoryMovementType): string | null {
  switch (movementType) {
    case "ISSUE_TO_STATION":
      return "Taken by";
    case "PURCHASE_RECEIPT":
      return "Posted by";
    case "WASTE":
      return "Recorded by";
    case "COUNT_ADJUSTMENT_IN":
    case "COUNT_ADJUSTMENT_OUT":
      return "Completed by";
    default:
      return null;
  }
}

export function formatQuantityMagnitude(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Direction must always be visually explicit (Part "QUANTITY
 * PRESENTATION") -- never an unsigned number when direction matters. */
export function formatSignedQuantity(direction: "IN" | "OUT", quantity: number, unitCode: string): string {
  const sign = direction === "IN" ? "+" : "-";
  return `${sign}${formatQuantityMagnitude(quantity)} ${unitCode}`;
}

export function formatActivityTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today" / "Yesterday" / "Aug 18" -- relative to `now` so this is
 * testable without depending on the real clock. */
export function activityDateGroupLabel(iso: string, now: Date): string {
  const occurred = new Date(iso);
  if (isSameCalendarDay(occurred, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(occurred, yesterday)) return "Yesterday";

  return occurred.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatActivityTimestamp(iso: string, now: Date): string {
  return `${activityDateGroupLabel(iso, now)} · ${formatActivityTime(iso)}`;
}

export interface ActivityDateGroup {
  label: string;
  entries: InventoryActivityEntry[];
}

/** Groups already-newest-first entries into consecutive date buckets,
 * preserving order -- never re-sorts (the server is the sole source of
 * ordering truth). */
export function groupActivityByDate(entries: InventoryActivityEntry[], now: Date): ActivityDateGroup[] {
  const groups: ActivityDateGroup[] = [];
  for (const entry of entries) {
    const label = activityDateGroupLabel(entry.occurredAt, now);
    const current = groups[groups.length - 1];
    if (current && current.label === label) {
      current.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return groups;
}

/** A withdrawal's stored location_id is only a genuinely EXACT, employee-
 * chosen source when location_attribution says so (Part "LEGACY /
 * ESTIMATED INVENTORY"): every ISSUE_TO_STATION row that predates the
 * 2A.5 exact-source-aware cutover was backfilled to LEGACY_ESTIMATED,
 * hard-derived from the station's own site location, never a real
 * choice. Never claim "X → Y" precision for those -- the destination
 * station is still always a real, stored fact and stays visible either
 * way. */
export function withdrawalSourceLabel(locationAttribution: "EXACT" | "LEGACY_ESTIMATED", locationName: string): string {
  return locationAttribution === "EXACT" ? `${locationName} → ` : "→ ";
}

export function wasteReasonLabel(reasonCode: string): string {
  return (WASTE_REASON_LABELS as Record<string, string>)[reasonCode] ?? reasonCode;
}
