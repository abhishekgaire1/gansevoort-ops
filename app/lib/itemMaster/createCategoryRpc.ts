import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export async function createInventoryCategoryRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; name: string }
): Promise<{ categoryId: string }> {
  const { data, error } = await supabase.rpc("create_inventory_category", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_name: input.name,
  });
  if (error) throw mapItemMasterRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_category_id: string } | undefined;
  if (!row) throw new Error("create_inventory_category returned no result row");
  return { categoryId: row.out_category_id };
}

export async function createSpendCategoryRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; name: string; parentId: string | null }
): Promise<{ categoryId: string }> {
  const { data, error } = await supabase.rpc("create_spend_category", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_name: input.name,
    p_parent_id: input.parentId,
  });
  if (error) throw mapItemMasterRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_category_id: string } | undefined;
  if (!row) throw new Error("create_spend_category returned no result row");
  return { categoryId: row.out_category_id };
}

export async function renameInventoryCategoryRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; categoryId: string; newName: string }
): Promise<void> {
  const { error } = await supabase.rpc("rename_inventory_category", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_category_id: input.categoryId,
    p_new_name: input.newName,
  });
  if (error) throw mapItemMasterRpcError(error);
}

export async function setInventoryCategoryActiveRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; categoryId: string; isActive: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("set_inventory_category_active", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_category_id: input.categoryId,
    p_is_active: input.isActive,
  });
  if (error) throw mapItemMasterRpcError(error);
}

export async function renameSpendCategoryRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; categoryId: string; newName: string }
): Promise<void> {
  const { error } = await supabase.rpc("rename_spend_category", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_category_id: input.categoryId,
    p_new_name: input.newName,
  });
  if (error) throw mapItemMasterRpcError(error);
}

export async function setSpendCategoryActiveRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; appUserId: string; categoryId: string; isActive: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("set_spend_category_active", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_category_id: input.categoryId,
    p_is_active: input.isActive,
  });
  if (error) throw mapItemMasterRpcError(error);
}
