"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  listAdminItems,
  getAdminItem,
  findSimilarItems,
  createAdminItem,
  updateAdminItemDetails,
  setAdminItemBaseUnit,
  setAdminItemStatus,
  bulkImportAdminItems,
  type AdminItemSummary,
  type AdminItemDetail,
  type SimilarItemCandidate,
  type ItemStatus,
  type BulkImportRow,
  type BulkImportRowResult,
} from "@/app/lib/admin/items";
import { AdminActionError } from "@/app/lib/admin/errors";

/**
 * Canonical Item Master + Inventory Relevance Classification milestone --
 * Admin-only Server Actions for browsing/creating/editing/deactivating
 * the Item Master catalog, plus Admin-only bulk import. Every action here
 * gates on requireAdmin() -- a plain Manager (who already has read access
 * to inventory_items for Receiving matching via the existing
 * app/actions/itemMaster.ts) is rejected server-side, not merely hidden
 * from the sidebar (Part 56).
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type ListAdminItemsResult = { ok: true; items: AdminItemSummary[] } | AuthFailure;

export async function listAdminItemsAction(search: string | null, categoryId: string | null, baseUnitCode: string | null, status: ItemStatus | null): Promise<ListAdminItemsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const items = await listAdminItems(getServiceRoleClient(), { organizationId: auth.manager.organizationId, search, categoryId, baseUnitCode, status });
  return { ok: true, items };
}

export type GetAdminItemResult = { ok: true; item: AdminItemDetail } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getAdminItemAction(itemId: string): Promise<GetAdminItemResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const item = await getAdminItem(getServiceRoleClient(), auth.manager.organizationId, itemId);
  if (!item) return { ok: false, reason: "not_found", message: "Item not found." };
  return { ok: true, item };
}

export interface VendorMappingSummary {
  vendorId: string;
  vendorName: string;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
  vendorSku: string | null;
  normalizedDescription: string | null;
  confirmedAt: string;
}

export type ListItemVendorMappingsResult = { ok: true; mappings: VendorMappingSummary[] } | AuthFailure;

/** A plain org-scoped read, not an RPC -- same pattern as the Identity +
 * Access Management milestone's getEmployeeAuthUserId (no business logic,
 * just a join for display, service-role bypasses RLS safely). Active
 * mappings only -- a superseded/remapped row is history, not what "this
 * vendor code currently means this item" today (Part 49). */
export async function listItemVendorMappingsAction(itemId: string): Promise<ListItemVendorMappingsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("vendor_item_mappings")
    .select("vendor_id, match_basis, vendor_sku, normalized_description, confirmed_at, vendors(name)")
    .eq("organization_id", auth.manager.organizationId)
    .eq("inventory_item_id", itemId)
    .eq("is_active", true)
    .order("confirmed_at", { ascending: false });
  if (error) throw new Error(error.message);

  const mappings: VendorMappingSummary[] = (data ?? []).map((row) => {
    const vendor = Array.isArray(row.vendors) ? row.vendors[0] : row.vendors;
    return {
      vendorId: row.vendor_id as string,
      vendorName: (vendor?.name as string | undefined) ?? "Unknown vendor",
      matchBasis: row.match_basis as "VENDOR_SKU" | "NORMALIZED_DESCRIPTION",
      vendorSku: row.vendor_sku as string | null,
      normalizedDescription: row.normalized_description as string | null,
      confirmedAt: row.confirmed_at as string,
    };
  });
  return { ok: true, mappings };
}

export type ListAllAdminItemKeysResult = { ok: true; items: { itemId: string; itemNumber: string; name: string }[] } | AuthFailure;

/** Every CONFIRMED INVENTORY item's number/name, unfiltered/unpaginated
 * -- used only for client-side Bulk Import preview validation (in-file
 * vs. existing-catalog collisions), never rendered as a picker list. */
export async function listAllAdminItemKeysAction(): Promise<ListAllAdminItemKeysResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const items = await listAdminItems(getServiceRoleClient(), { organizationId: auth.manager.organizationId, status: null });
  return { ok: true, items: items.map((i) => ({ itemId: i.itemId, itemNumber: i.itemNumber, name: i.name })) };
}

export type FindSimilarItemsResult = { ok: true; candidates: SimilarItemCandidate[] } | AuthFailure;

export async function findSimilarItemsAction(name: string, excludeItemId?: string): Promise<FindSimilarItemsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const candidates = await findSimilarItems(getServiceRoleClient(), auth.manager.organizationId, name, excludeItemId);
  return { ok: true, candidates };
}

export type AdminItemMutationResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; code: string; message: string; existingItemId?: string; existingItemName?: string };

function toMutationResult(err: unknown): AdminItemMutationResult {
  if (err instanceof AdminActionError) {
    let existingItemId: string | undefined;
    let existingItemName: string | undefined;
    if (err.code === "DUPLICATE_ITEM_NAME" && err.detail) {
      try {
        const parsed = JSON.parse(err.detail) as { existingItemId?: string; existingItemName?: string };
        existingItemId = parsed.existingItemId;
        existingItemName = parsed.existingItemName;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    return { ok: false, reason: "error", code: err.code, message: err.message, existingItemId, existingItemName };
  }
  return { ok: false, reason: "error", code: "UNKNOWN", message: "Unable to save. Try again." };
}

export type CreateAdminItemActionResult = { ok: true; itemId: string; itemNumber: string } | AuthFailure | { ok: false; reason: "error"; code: string; message: string; existingItemId?: string; existingItemName?: string };

export async function createAdminItemAction(name: string, categoryId: string, baseUnitId: string): Promise<CreateAdminItemActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!name.trim()) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "Canonical name is required." };
  }

  try {
    const result = await createAdminItem(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, name, categoryId, baseUnitId);
    return { ok: true, itemId: result.itemId, itemNumber: result.itemNumber };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok) throw err;
    return mapped;
  }
}

export async function updateAdminItemDetailsAction(itemId: string, name: string, categoryId: string): Promise<AdminItemMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await updateAdminItemDetails(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, itemId, name, categoryId);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setAdminItemBaseUnitAction(itemId: string, baseUnitId: string): Promise<AdminItemMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setAdminItemBaseUnit(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, itemId, baseUnitId);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setAdminItemStatusAction(itemId: string, status: ItemStatus): Promise<AdminItemMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setAdminItemStatus(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, itemId, status);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export type BulkImportAdminItemsActionResult = { ok: true; results: BulkImportRowResult[] } | AuthFailure | { ok: false; reason: "error"; message: string };

/** Admin-only (Part 16). Rows are already parsed AND client-side
 * pre-validated (required fields, category/unit name resolved to id) by
 * the time they reach here -- this action's own job is only the
 * authorization gate and forwarding to the RPC, which re-validates
 * everything server-side regardless (Part 80: never trust the preview as
 * the final guarantee). */
export async function bulkImportAdminItemsAction(filename: string | null, rows: BulkImportRow[]): Promise<BulkImportAdminItemsActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (rows.length === 0) {
    return { ok: false, reason: "error", message: "No rows to import." };
  }

  try {
    const results = await bulkImportAdminItems(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, filename, rows);
    return { ok: true, results };
  } catch (err) {
    if (err instanceof AdminActionError) {
      return { ok: false, reason: "error", message: err.message };
    }
    throw err;
  }
}
