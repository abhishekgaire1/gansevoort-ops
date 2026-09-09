import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAdminRpcError } from "@/app/lib/admin/errors";

/**
 * Canonical Item Master + Inventory Relevance Classification milestone --
 * the Admin-only browse/detail/manual-create/rename/base-unit-change/
 * deactivate-reactivate/bulk-import surface for inventory_items. This is
 * deliberately NOT a parallel item system: it operates on the exact same
 * inventory_items table the existing Receiving/classification pipeline
 * (app/lib/itemMaster/) already writes to, scoped to
 * disposition='INVENTORY' and approval_status='CONFIRMED' rows only --
 * the actual catalog, never an in-flight AI proposal or a NON_INVENTORY
 * expense-classification row (see the migration's own header comment for
 * why those live on the same table).
 */

export type ItemStatus = "active" | "inactive";

export type AdminItemSort = "name" | "item_number" | "category" | "updated";

export interface AdminItemSummary {
  itemId: string;
  itemNumber: string;
  name: string;
  categoryName: string | null;
  baseUnitCode: string | null;
  status: ItemStatus;
  updatedAt: string;
}

interface AdminItemRow {
  out_item_id: string;
  out_item_number: string;
  out_name: string;
  out_category_name: string | null;
  out_base_unit_code: string | null;
  out_status: ItemStatus;
  out_updated_at: string;
}

function mapItemRow(row: AdminItemRow): AdminItemSummary {
  return {
    itemId: row.out_item_id,
    itemNumber: row.out_item_number,
    name: row.out_name,
    categoryName: row.out_category_name,
    baseUnitCode: row.out_base_unit_code,
    status: row.out_status,
    updatedAt: row.out_updated_at,
  };
}

export interface ListAdminItemsInput {
  organizationId: string;
  search?: string | null;
  categoryId?: string | null;
  baseUnitCode?: string | null;
  status?: ItemStatus | null;
  sort?: AdminItemSort | null;
}

/** Admin Item Master is deliberately INVENTORY-catalog-only (spend/
 * expense-classification rows are a different domain concept, never
 * shown here -- see tests/adminItemMaster.rpc.test.ts's dedicated
 * "Non-inventory / pending-review items never appear in the Admin Item
 * Master surfaces" coverage). There is no disposition filter parameter:
 * this RPC always scopes to disposition = 'INVENTORY' server-side. */
export async function listAdminItems(supabase: SupabaseClient, input: ListAdminItemsInput): Promise<AdminItemSummary[]> {
  const { data, error } = await supabase.rpc("list_admin_items", {
    p_organization_id: input.organizationId,
    p_search: input.search?.trim() ? input.search.trim() : null,
    p_category_id: input.categoryId ?? null,
    p_base_unit_code: input.baseUnitCode ?? null,
    p_status: input.status ?? null,
    p_sort: input.sort ?? "name",
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as AdminItemRow[]).map(mapItemRow);
}

export interface AdminItemDetail {
  itemId: string;
  itemNumber: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  baseUnitId: string | null;
  baseUnitCode: string | null;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  /** Blocks a base-unit change when true (Part 45) -- surfaced so the UI
   * can disable/explain the control before the Admin even attempts it,
   * though the RPC re-checks server-side regardless. */
  hasMovementHistory: boolean;
  /** Always "INVENTORY" -- get_admin_item is scoped to disposition =
   * 'INVENTORY' server-side (Admin Item Master never surfaces a
   * NON_INVENTORY/expense row); kept as a field only so
   * ItemOverviewSection's existing display doesn't need a separate
   * conditional for a value that can never actually vary here. */
  disposition: "INVENTORY";
  spendCategoryId: string | null;
  spendCategoryName: string | null;
  defaultReceivingLocationId: string | null;
  defaultReceivingLocationName: string | null;
}

export async function getAdminItem(supabase: SupabaseClient, organizationId: string, itemId: string): Promise<AdminItemDetail | null> {
  const { data, error } = await supabase.rpc("get_admin_item", { p_organization_id: organizationId, p_item_id: itemId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_item_id: string;
        out_item_number: string;
        out_name: string;
        out_category_id: string | null;
        out_category_name: string | null;
        out_base_unit_id: string | null;
        out_base_unit_code: string | null;
        out_status: ItemStatus;
        out_created_at: string;
        out_updated_at: string;
        out_has_movement_history: boolean;
        out_spend_category_id: string | null;
        out_spend_category_name: string | null;
        out_default_receiving_location_id: string | null;
        out_default_receiving_location_name: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    itemId: row.out_item_id,
    itemNumber: row.out_item_number,
    name: row.out_name,
    categoryId: row.out_category_id,
    categoryName: row.out_category_name,
    baseUnitId: row.out_base_unit_id,
    baseUnitCode: row.out_base_unit_code,
    status: row.out_status,
    createdAt: row.out_created_at,
    updatedAt: row.out_updated_at,
    hasMovementHistory: row.out_has_movement_history,
    disposition: "INVENTORY",
    spendCategoryId: row.out_spend_category_id,
    spendCategoryName: row.out_spend_category_name,
    defaultReceivingLocationId: row.out_default_receiving_location_id,
    defaultReceivingLocationName: row.out_default_receiving_location_name,
  };
}

export interface SimilarItemCandidate {
  itemId: string;
  itemNumber: string;
  name: string;
  categoryName: string | null;
  baseUnitCode: string | null;
  similarity: number;
  isExact: boolean;
}

/** Fuzzy possible-duplicate search (Part 15) -- distinct from the hard
 * exact-duplicate BLOCK every create/rename RPC below already enforces.
 * Called by the UI BEFORE submitting a create/import, so the Admin sees
 * "possible existing item" warnings and can deliberately confirm past
 * them; never auto-dismissed. */
export async function findSimilarItems(supabase: SupabaseClient, organizationId: string, name: string, excludeItemId?: string): Promise<SimilarItemCandidate[]> {
  if (!name.trim()) return [];
  const { data, error } = await supabase.rpc("find_similar_active_items", {
    p_organization_id: organizationId,
    p_name: name.trim(),
    p_exclude_item_id: excludeItemId ?? null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { out_item_id: string; out_item_number: string; out_name: string; out_category_name: string | null; out_base_unit_code: string | null; out_similarity: number; out_is_exact: boolean }[]).map(
    (row) => ({
      itemId: row.out_item_id,
      itemNumber: row.out_item_number,
      name: row.out_name,
      categoryName: row.out_category_name,
      baseUnitCode: row.out_base_unit_code,
      similarity: row.out_similarity,
      isExact: row.out_is_exact,
    })
  );
}

export interface CreateAdminItemResult {
  itemId: string;
  itemNumber: string;
}

export async function createAdminItem(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  name: string,
  categoryId: string,
  baseUnitId: string
): Promise<CreateAdminItemResult> {
  const { data, error } = await supabase.rpc("create_admin_item", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_name: name,
    p_category_id: categoryId,
    p_base_unit_id: baseUnitId,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_item_id: string; out_item_number: string } | undefined;
  if (!row) throw new Error("create_admin_item returned no result");
  return { itemId: row.out_item_id, itemNumber: row.out_item_number };
}

export async function updateAdminItemDetails(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  itemId: string,
  name: string,
  categoryId: string
): Promise<void> {
  const { error } = await supabase.rpc("update_admin_item_details", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_item_id: itemId,
    p_name: name,
    p_category_id: categoryId,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setAdminItemBaseUnit(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, itemId: string, baseUnitId: string): Promise<void> {
  const { error } = await supabase.rpc("set_admin_item_base_unit", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_item_id: itemId,
    p_base_unit_id: baseUnitId,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setAdminItemStatus(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, itemId: string, status: ItemStatus): Promise<void> {
  const { error } = await supabase.rpc("set_admin_item_status", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_item_id: itemId,
    p_status: status,
  });
  if (error) throw mapAdminRpcError(error);
}

export interface BulkImportRow {
  rowIndex: number;
  itemNumber?: string | null;
  name: string;
  categoryId: string | null;
  baseUnitId: string | null;
  status?: ItemStatus;
}

export interface BulkImportRowResult {
  rowIndex: number;
  outcome: "IMPORTED" | "DUPLICATE_SKIPPED" | "REJECTED";
  itemId: string | null;
  itemNumber: string | null;
  message: string | null;
}

export async function bulkImportAdminItems(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  filename: string | null,
  rows: BulkImportRow[]
): Promise<BulkImportRowResult[]> {
  const { data, error } = await supabase.rpc("bulk_import_admin_items", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_filename: filename,
    p_rows: rows,
  });
  if (error) throw mapAdminRpcError(error);
  return ((data ?? []) as { out_row_index: number; out_outcome: string; out_item_id: string | null; out_item_number: string | null; out_message: string | null }[]).map((row) => ({
    rowIndex: row.out_row_index,
    outcome: row.out_outcome as BulkImportRowResult["outcome"],
    itemId: row.out_item_id,
    itemNumber: row.out_item_number,
    message: row.out_message,
  }));
}
