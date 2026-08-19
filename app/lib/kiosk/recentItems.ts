import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Last N DISTINCT items an employee has successfully withdrawn, newest
 * distinct item first (Milestone 2A.5 §12-14). Sourced from
 * list_employee_recent_withdrawn_item_ids (20260811100078), which reads
 * inventory_movements directly -- every row there is already a
 * successfully committed ISSUE_TO_STATION withdrawal (record_inventory_
 * withdrawal writes it inside one all-or-nothing transaction), so there
 * is no separate "abandoned attempt" state to exclude.
 *
 * Deliberately returns raw ids only, in recency order -- NOT filtered
 * against current stock here. The caller (app/actions/recentItems.ts ->
 * KioskApp) intersects these ids against the same currently-withdrawable
 * item list the browsing grid already fetches (listActiveInventoryItemsForOrganization),
 * so an item that has since sold out is dropped automatically and Recent
 * can never show a card the grid itself would refuse to show.
 */
export async function listEmployeeRecentWithdrawnItemIds(
  supabase: SupabaseClient,
  organizationId: string,
  appUserId: string,
  limit = 6
): Promise<string[]> {
  const { data, error } = await supabase.rpc("list_employee_recent_withdrawn_item_ids", {
    p_organization_id: organizationId,
    p_app_user_id: appUserId,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`list_employee_recent_withdrawn_item_ids failed: ${error.message}`);
  }

  return ((data ?? []) as { out_inventory_item_id: string }[]).map((row) => row.out_inventory_item_id);
}
