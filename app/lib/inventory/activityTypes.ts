import type { WasteReasonCode } from "@/app/lib/inventory/wasteReasons";

/**
 * Shared, client-safe (no "server-only") activity types and row-mapping
 * shared by BOTH the item-scoped Activity timeline
 * (list_inventory_item_activity, 20260811100089) and the global
 * Inventory Activity feed (list_inventory_activity, 20260811100090) --
 * two read models over the SAME ledger columns, never two separate
 * timeline implementations (Global Inventory Activity milestone, Part 5).
 */

export type InventoryMovementType =
  | "PURCHASE_RECEIPT"
  | "ISSUE_TO_STATION"
  | "WASTE"
  | "COUNT_ADJUSTMENT_IN"
  | "COUNT_ADJUSTMENT_OUT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export type ActivityDirection = "IN" | "OUT";

const IN_MOVEMENT_TYPES = new Set<InventoryMovementType>(["PURCHASE_RECEIPT", "COUNT_ADJUSTMENT_IN", "TRANSFER_IN"]);

export function directionForMovementType(movementType: InventoryMovementType): ActivityDirection {
  return IN_MOVEMENT_TYPES.has(movementType) ? "IN" : "OUT";
}

export interface InventoryActivityEntry {
  id: string;
  movementId: string;
  movementType: InventoryMovementType;
  direction: ActivityDirection;
  quantity: number;
  baseUnitCode: string;
  occurredAt: string;
  locationAttribution: "EXACT" | "LEGACY_ESTIMATED";
  station: { id: string; name: string } | null;
  actor: { appUserId: string; name: string | null } | null;
  purchaseDocument: { id: string; documentNumber: string | null } | null;
  vendor: { id: string; name: string } | null;
  waste: { id: string; reasonCode: WasteReasonCode; note: string | null } | null;
  cycleCount: { id: string; expectedQuantity: number; countedQuantity: number } | null;
}

/** The provenance columns both list_inventory_item_activity and
 * list_inventory_activity return identically. */
export interface BaseActivityRow {
  out_movement_line_id: string;
  out_movement_id: string;
  out_movement_type: string;
  out_occurred_at: string;
  out_quantity: string | number;
  out_base_unit_code: string;
  out_location_attribution: string;
  out_station_id: string | null;
  out_station_name: string | null;
  out_performed_by_app_user_id: string | null;
  out_purchase_document_id: string | null;
  out_document_number: string | null;
  out_vendor_id: string | null;
  out_vendor_name: string | null;
  out_waste_event_id: string | null;
  out_waste_reason_code: string | null;
  out_waste_note: string | null;
  out_cycle_count_id: string | null;
  out_cycle_count_expected_quantity: string | number | null;
  out_cycle_count_physical_quantity: string | number | null;
}

export function mapBaseActivityRow(row: BaseActivityRow, actorName: string | null): InventoryActivityEntry {
  const movementType = row.out_movement_type as InventoryMovementType;
  return {
    id: row.out_movement_line_id,
    movementId: row.out_movement_id,
    movementType,
    direction: directionForMovementType(movementType),
    quantity: Number(row.out_quantity),
    baseUnitCode: row.out_base_unit_code,
    occurredAt: row.out_occurred_at,
    locationAttribution: row.out_location_attribution as "EXACT" | "LEGACY_ESTIMATED",
    station: row.out_station_id ? { id: row.out_station_id, name: row.out_station_name ?? "" } : null,
    actor: row.out_performed_by_app_user_id ? { appUserId: row.out_performed_by_app_user_id, name: actorName } : null,
    purchaseDocument: row.out_purchase_document_id ? { id: row.out_purchase_document_id, documentNumber: row.out_document_number } : null,
    vendor: row.out_vendor_id && row.out_vendor_name ? { id: row.out_vendor_id, name: row.out_vendor_name } : null,
    waste:
      row.out_waste_event_id && row.out_waste_reason_code
        ? { id: row.out_waste_event_id, reasonCode: row.out_waste_reason_code as WasteReasonCode, note: row.out_waste_note }
        : null,
    cycleCount:
      row.out_cycle_count_id && row.out_cycle_count_expected_quantity !== null && row.out_cycle_count_physical_quantity !== null
        ? {
            id: row.out_cycle_count_id,
            expectedQuantity: Number(row.out_cycle_count_expected_quantity),
            countedQuantity: Number(row.out_cycle_count_physical_quantity),
          }
        : null,
  };
}
