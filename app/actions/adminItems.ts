"use server";

import { requireAdmin, requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
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
  type AdminItemSort,
  type BulkImportRow,
  type BulkImportRowResult,
} from "@/app/lib/admin/items";
import { AdminActionError } from "@/app/lib/admin/errors";
import { getItemWorkspaceOverview, getAdminItemArchiveDependencies, type ItemWorkspaceOverview, type ArchiveDependencies } from "@/app/lib/admin/itemWorkspace";
import { listItemHistory, type ItemHistoryEntry } from "@/app/lib/admin/itemHistory";
import {
  listItemVendorPackages,
  setVendorPurchasePackage,
  listReceiptsUsingVendorPackage,
  correctReceiptPackageFactor,
  type VendorPackageSummary,
  type ReceivingBehavior,
  type ReceiptUsingPackageVersion,
} from "@/app/lib/admin/vendorPackages";
import { recordInventoryCorrection, previewInventoryCorrection, type CorrectionMode, type InventoryCorrectionPreview } from "@/app/lib/inventory/corrections";
import { InvalidCorrectionInputError, CrossOrganizationReferenceError } from "@/app/lib/inventory/errors";

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
const NOT_AUTHORIZED_MANAGER: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a Manager or Admin." };

/** Safe editing of confirmed items -- read access to the redesigned Items
 * list/workspace is now Manager-or-Admin (previously Admin-only): a
 * Manager needs to be able to browse items and open the workspace to make
 * the no-impact metadata edits the tiered-permissions decision opens up
 * to them. Every INVENTORY-AFFECTING or structural mutation below
 * (vendor package, usage unit, base unit, archive, bulk import, Adjust
 * Inventory, receipt correction) stays requireAdmin() -- only the read
 * surface and the plain metadata edit widen. */
export type ListAdminItemsResult = { ok: true; items: AdminItemSummary[] } | AuthFailure;

export async function listAdminItemsAction(
  search: string | null,
  categoryId: string | null,
  baseUnitCode: string | null,
  status: ItemStatus | null,
  sort: AdminItemSort | null = "name"
): Promise<ListAdminItemsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

  const items = await listAdminItems(getServiceRoleClient(), { organizationId: auth.manager.organizationId, search, categoryId, baseUnitCode, status, sort });
  return { ok: true, items };
}

export type GetAdminItemResult = { ok: true; item: AdminItemDetail } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getAdminItemAction(itemId: string): Promise<GetAdminItemResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

  const item = await getAdminItem(getServiceRoleClient(), auth.manager.organizationId, itemId);
  if (!item) return { ok: false, reason: "not_found", message: "Item not found." };
  return { ok: true, item };
}

export type GetItemWorkspaceOverviewResult = { ok: true; overview: ItemWorkspaceOverview } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getItemWorkspaceOverviewAction(itemId: string): Promise<GetItemWorkspaceOverviewResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

  const overview = await getItemWorkspaceOverview(getServiceRoleClient(), auth.manager.organizationId, itemId);
  if (!overview) return { ok: false, reason: "not_found", message: "Item not found." };
  return { ok: true, overview };
}

export type ListItemVendorPackagesResult = { ok: true; packages: VendorPackageSummary[] } | AuthFailure;

export async function listItemVendorPackagesAction(itemId: string): Promise<ListItemVendorPackagesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

  const packages = await listItemVendorPackages(getServiceRoleClient(), auth.manager.organizationId, itemId);
  return { ok: true, packages };
}

export type ListItemHistoryResult = { ok: true; entries: ItemHistoryEntry[] } | AuthFailure;

export async function listItemHistoryAction(itemId: string): Promise<ListItemHistoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

  const entries = await listItemHistory(getServiceRoleClient(), auth.manager.organizationId, itemId);
  return { ok: true, entries };
}

export type GetAdminItemArchiveDependenciesResult = { ok: true; dependencies: ArchiveDependencies } | AuthFailure;

/** Read-only, but still Admin-gated -- this is preparation specifically
 * for the Admin-only Archive confirmation flow, not a general Manager
 * read. */
export async function getAdminItemArchiveDependenciesAction(itemId: string): Promise<GetAdminItemArchiveDependenciesResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const dependencies = await getAdminItemArchiveDependencies(getServiceRoleClient(), auth.manager.organizationId, itemId);
  return { ok: true, dependencies };
}

export type ListReceiptsUsingVendorPackageResult = { ok: true; receipts: ReceiptUsingPackageVersion[] } | AuthFailure;

export async function listReceiptsUsingVendorPackageAction(vendorItemPurchaseUnitId: string): Promise<ListReceiptsUsingVendorPackageResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const receipts = await listReceiptsUsingVendorPackage(getServiceRoleClient(), auth.manager.organizationId, vendorItemPurchaseUnitId);
  return { ok: true, receipts };
}

export type SetVendorPurchasePackageResult = { ok: true; vendorItemPurchaseUnitId: string } | AuthFailure | { ok: false; reason: "error"; message: string };

/** Future-transactions-only by construction (delegates to the existing
 * versioned upsert helper) -- Admin-only for now, matching every existing
 * vendor-package-adjacent RPC's gating (flagged in the plan as
 * revisitable, not a decision to relitigate here). */
export async function setVendorPurchasePackageAction(
  vendorItemMappingId: string,
  purchaseUnitCode: string,
  receivingBehavior: ReceivingBehavior,
  conversionFactor: number | null,
  requiresActualMeasurement: boolean
): Promise<SetVendorPurchasePackageResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await setVendorPurchasePackage(
      getServiceRoleClient(),
      auth.manager.organizationId,
      auth.manager.appUserId,
      vendorItemMappingId,
      purchaseUnitCode,
      receivingBehavior,
      conversionFactor,
      requiresActualMeasurement
    );
    return { ok: true, vendorItemPurchaseUnitId: result.vendorItemPurchaseUnitId };
  } catch (err) {
    if (err instanceof AdminActionError) return { ok: false, reason: "error", message: err.message };
    throw err;
  }
}

export type CorrectReceiptPackageFactorActionResult = { ok: true; correctionIds: string[]; replayed: boolean } | AuthFailure | { ok: false; reason: "error"; message: string };

/** The flagship "current inventory will change" workflow -- Admin-only.
 * Never rewrites the original receipt/posting/movement rows; only inserts
 * new correction rows referencing them. */
export async function correctReceiptPackageFactorAction(
  postingLineIds: string[],
  newVendorItemPurchaseUnitId: string,
  reason: string,
  clientRequestId: string
): Promise<CorrectReceiptPackageFactorActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await correctReceiptPackageFactor(
      getServiceRoleClient(),
      auth.manager.organizationId,
      auth.manager.appUserId,
      postingLineIds,
      newVendorItemPurchaseUnitId,
      reason,
      clientRequestId
    );
    return { ok: true, correctionIds: result.correctionIds, replayed: result.replayed };
  } catch (err) {
    if (err instanceof InvalidCorrectionInputError || err instanceof CrossOrganizationReferenceError) {
      return { ok: false, reason: "error", message: err.message };
    }
    if (err instanceof Error) return { ok: false, reason: "error", message: err.message };
    throw err;
  }
}

export type PreviewInventoryCorrectionResult = { ok: true; preview: InventoryCorrectionPreview } | AuthFailure;

export async function previewInventoryCorrectionAction(
  inventoryItemId: string,
  locationId: string,
  mode: CorrectionMode,
  countedQuantity: number | null,
  deltaQuantity: number | null
): Promise<PreviewInventoryCorrectionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const preview = await previewInventoryCorrection(getServiceRoleClient(), auth.manager.organizationId, inventoryItemId, locationId, mode, countedQuantity, deltaQuantity);
  return { ok: true, preview };
}

export type RecordInventoryCorrectionActionResult =
  | { ok: true; correctionId: string; previousBalance: number; newBalance: number; replayed: boolean }
  | AuthFailure
  | { ok: false; reason: "error"; message: string };

/** The generic "Adjust Inventory" action -- Admin-only. Creates an
 * inventory_corrections + inventory_movements row through
 * record_inventory_correction; never mutates a balance column directly
 * (none exists). */
export async function recordInventoryCorrectionAction(
  inventoryItemId: string,
  locationId: string,
  mode: CorrectionMode,
  countedQuantity: number | null,
  deltaQuantity: number | null,
  reason: string,
  clientRequestId: string
): Promise<RecordInventoryCorrectionActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await recordInventoryCorrection(getServiceRoleClient(), auth.manager.appUserId, inventoryItemId, locationId, mode, countedQuantity, deltaQuantity, reason, clientRequestId);
    return { ok: true, correctionId: result.correctionId, previousBalance: result.previousBalance, newBalance: result.newBalance, replayed: result.replayed };
  } catch (err) {
    if (err instanceof InvalidCorrectionInputError) return { ok: false, reason: "error", message: err.message };
    if (err instanceof Error) return { ok: false, reason: "error", message: err.message };
    throw err;
  }
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

/** No-impact metadata edit (name/category only) -- Manager-or-Admin per
 * the tiered-permissions decision: this can never alter current
 * inventory, so it doesn't need the Admin-only bar every inventory-
 * affecting or structural action below keeps. */
export async function updateAdminItemDetailsAction(itemId: string, name: string, categoryId: string): Promise<AdminItemMutationResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED_MANAGER;

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
