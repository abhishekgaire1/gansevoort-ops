"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { rejectItemProposalRpc } from "@/app/lib/itemMaster/rejectItemProposalRpc";
import {
  createInventoryCategoryRpc,
  createSpendCategoryRpc,
  renameInventoryCategoryRpc,
  setInventoryCategoryActiveRpc,
  renameSpendCategoryRpc,
  setSpendCategoryActiveRpc,
} from "@/app/lib/itemMaster/createCategoryRpc";
import { ItemProposalReferencedError, ItemNotPendingReviewError, CategoryAlreadyExistsError } from "@/app/lib/itemMaster/errors";

export interface InventoryItemSummary {
  id: string;
  name: string;
  disposition: "INVENTORY" | "NON_INVENTORY";
  approvalStatus: "PENDING_REVIEW" | "CONFIRMED";
  createdVia: "MANUAL" | "AI_PROPOSED";
  categoryName: string | null;
  baseUnitCode: string | null;
}

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type ListInventoryItemsResult = { ok: true; items: InventoryItemSummary[] } | AuthFailure;

/** CONFIRMED-only by default -- the org-scoped picker for line-classification
 * overrides and vendor-mapping remaps. Pass includePendingReview to power
 * /manager/items/review instead. */
export async function listInventoryItems(options?: { includePendingReview?: boolean; search?: string }): Promise<ListInventoryItemsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  let query = supabase
    .from("inventory_items")
    .select("id, name, disposition, approval_status, created_via, inventory_categories(name), units(code)")
    .eq("organization_id", auth.manager.organizationId)
    .order("name")
    .limit(200);

  query = options?.includePendingReview ? query.in("approval_status", ["CONFIRMED", "PENDING_REVIEW"]) : query.eq("approval_status", "CONFIRMED");

  if (options?.search?.trim()) {
    query = query.ilike("name", `%${options.search.trim()}%`);
  }

  const { data } = await query;
  const items: InventoryItemSummary[] = (data ?? []).map((row) => {
    const category = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    return {
      id: row.id as string,
      name: row.name as string,
      disposition: row.disposition as "INVENTORY" | "NON_INVENTORY",
      approvalStatus: row.approval_status as "PENDING_REVIEW" | "CONFIRMED",
      createdVia: row.created_via as "MANUAL" | "AI_PROPOSED",
      categoryName: (category?.name as string | undefined) ?? null,
      baseUnitCode: (unit?.code as string | undefined) ?? null,
    };
  });

  return { ok: true, items };
}

export interface CategorySummary {
  id: string;
  name: string;
  isActive?: boolean;
}

export type ListCategoriesResult = { ok: true; categories: CategorySummary[] } | AuthFailure;

/** Active-only by default -- pickers (new-item form, review modal) never
 * offer a deactivated category. Pass includeInactive for the settings
 * page, which needs to show and reactivate them. */
export async function listInventoryCategories(options?: { includeInactive?: boolean }): Promise<ListCategoriesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  let query = supabase.from("inventory_categories").select("id, name, is_active").eq("organization_id", auth.manager.organizationId).order("name");
  if (!options?.includeInactive) query = query.eq("is_active", true);

  const { data } = await query;
  return { ok: true, categories: (data ?? []).map((c) => ({ id: c.id as string, name: c.name as string, isActive: c.is_active as boolean })) };
}

export interface SpendCategorySummary {
  id: string;
  parentId: string | null;
  name: string;
  isActive?: boolean;
}

export type ListSpendCategoriesResult = { ok: true; categories: SpendCategorySummary[] } | AuthFailure;

/** Flat list (any depth) -- the UI flattens this into "Food > Protein >
 * Poultry"-style paths for the picker (plan §14). Active-only by default,
 * same includeInactive escape hatch as listInventoryCategories. */
export async function listSpendCategories(options?: { includeInactive?: boolean }): Promise<ListSpendCategoriesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  let query = supabase.from("spend_categories").select("id, parent_id, name, is_active").eq("organization_id", auth.manager.organizationId).order("name");
  if (!options?.includeInactive) query = query.eq("is_active", true);

  const { data } = await query;
  return {
    ok: true,
    categories: (data ?? []).map((c) => ({ id: c.id as string, parentId: c.parent_id as string | null, name: c.name as string, isActive: c.is_active as boolean })),
  };
}

export interface UnitSummary {
  code: string;
  name: string;
  unitType: string;
}

export type ListUnitsResult = { ok: true; units: UnitSummary[] } | AuthFailure;

export async function listUnits(): Promise<ListUnitsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data } = await supabase.from("units").select("code, name, unit_type").order("name");

  return { ok: true, units: (data ?? []).map((u) => ({ code: u.code as string, name: u.name as string, unitType: u.unit_type as string })) };
}

export type RejectItemProposalResult = { ok: true } | AuthFailure | { ok: false; reason: "not_pending" | "referenced" | "misconfigured"; message: string };

/** Only reachable for a PENDING_REVIEW item unreferenced by any
 * classification or vendor mapping -- reassign the line first otherwise. */
export async function rejectItemProposal(inventoryItemId: string, reason?: string): Promise<RejectItemProposalResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await rejectItemProposalRpc(getServiceRoleClient(), {
      inventoryItemId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      reason,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof ItemNotPendingReviewError) {
      return { ok: false, reason: "not_pending", message: "This item is no longer a pending proposal." };
    }
    if (err instanceof ItemProposalReferencedError) {
      return { ok: false, reason: "referenced", message: "This proposal is still referenced by a line or vendor mapping. Reassign it first." };
    }
    return { ok: false, reason: "misconfigured", message: "Could not reject the proposal. Try again." };
  }
}

export type CreateCategoryResult =
  | { ok: true; categoryId: string }
  | AuthFailure
  | { ok: false; reason: "duplicate" | "invalid_name" | "misconfigured"; message: string };

/** Managers may create a missing canonical inventory category on the spot
 * -- the seeded taxonomy (scripts/seed-canonical-categories.ts) is a
 * starting point, not permanently closed. AI never calls this itself. */
export async function createInventoryCategory(name: string): Promise<CreateCategoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!name.trim()) {
    return { ok: false, reason: "invalid_name", message: "A category name is required." };
  }

  try {
    const result = await createInventoryCategoryRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      name: name.trim(),
    });
    return { ok: true, categoryId: result.categoryId };
  } catch (err) {
    if (err instanceof CategoryAlreadyExistsError) {
      return { ok: false, reason: "duplicate", message: "A category with that name already exists." };
    }
    return { ok: false, reason: "misconfigured", message: "Could not create the category. Try again." };
  }
}

export async function createSpendCategory(name: string, parentId: string | null): Promise<CreateCategoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!name.trim()) {
    return { ok: false, reason: "invalid_name", message: "A category name is required." };
  }

  try {
    const result = await createSpendCategoryRpc(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      name: name.trim(),
      parentId,
    });
    return { ok: true, categoryId: result.categoryId };
  } catch (err) {
    if (err instanceof CategoryAlreadyExistsError) {
      return { ok: false, reason: "duplicate", message: "A spend category with that name already exists at that level." };
    }
    return { ok: false, reason: "misconfigured", message: "Could not create the spend category. Try again." };
  }
}

export type CategoryActionResult = { ok: true } | AuthFailure | { ok: false; reason: "duplicate" | "invalid_name" | "misconfigured"; message: string };

export async function renameInventoryCategory(categoryId: string, newName: string): Promise<CategoryActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  if (!newName.trim()) return { ok: false, reason: "invalid_name", message: "A category name is required." };

  try {
    await renameInventoryCategoryRpc(getServiceRoleClient(), { organizationId: auth.manager.organizationId, appUserId: auth.manager.appUserId, categoryId, newName: newName.trim() });
    return { ok: true };
  } catch (err) {
    if (err instanceof CategoryAlreadyExistsError) return { ok: false, reason: "duplicate", message: "A category with that name already exists." };
    return { ok: false, reason: "misconfigured", message: "Could not rename the category. Try again." };
  }
}

export async function setInventoryCategoryActive(categoryId: string, isActive: boolean): Promise<CategoryActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setInventoryCategoryActiveRpc(getServiceRoleClient(), { organizationId: auth.manager.organizationId, appUserId: auth.manager.appUserId, categoryId, isActive });
    return { ok: true };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not update the category. Try again." };
  }
}

export async function renameSpendCategory(categoryId: string, newName: string): Promise<CategoryActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  if (!newName.trim()) return { ok: false, reason: "invalid_name", message: "A category name is required." };

  try {
    await renameSpendCategoryRpc(getServiceRoleClient(), { organizationId: auth.manager.organizationId, appUserId: auth.manager.appUserId, categoryId, newName: newName.trim() });
    return { ok: true };
  } catch (err) {
    if (err instanceof CategoryAlreadyExistsError) return { ok: false, reason: "duplicate", message: "A spend category with that name already exists at that level." };
    return { ok: false, reason: "misconfigured", message: "Could not rename the spend category. Try again." };
  }
}

export async function setSpendCategoryActive(categoryId: string, isActive: boolean): Promise<CategoryActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setSpendCategoryActiveRpc(getServiceRoleClient(), { organizationId: auth.manager.organizationId, appUserId: auth.manager.appUserId, categoryId, isActive });
    return { ok: true };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not update the spend category. Try again." };
  }
}
