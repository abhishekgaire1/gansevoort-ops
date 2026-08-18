import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface SetInventoryItemDefaultReceivingLocationInput {
  organizationId: string;
  appUserId: string;
  inventoryItemId: string;
  locationId: string;
}

/** Learns (or updates) an item's default receiving location -- only ever
 * called after a receipt has already been successfully recorded for that
 * item's line, never merely because a draft form was opened or edited. A
 * quiet no-op (no write, no audit event) when the location isn't actually
 * changing. */
export async function setInventoryItemDefaultReceivingLocationRpc(
  supabase: SupabaseClient,
  input: SetInventoryItemDefaultReceivingLocationInput
): Promise<void> {
  const { error } = await supabase.rpc("set_inventory_item_default_receiving_location", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_inventory_item_id: input.inventoryItemId,
    p_location_id: input.locationId,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
