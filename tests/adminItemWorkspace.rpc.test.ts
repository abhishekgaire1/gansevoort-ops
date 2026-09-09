import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { listAdminItems, getAdminItem, createAdminItem } from "@/app/lib/admin/items";
import { getAdminItemArchiveDependencies } from "@/app/lib/admin/itemWorkspace";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminItemMaster.rpc.test.ts's header
 * comment (same convention).
 *
 * Safe editing of confirmed items -- covers the workspace-level widening
 * this feature adds on top of the pre-existing Admin Item Master surface:
 * list_admin_items' sort param (20260811100144), get_admin_item's widened
 * return shape (20260811100145), and the new
 * get_admin_item_archive_dependencies read (20260811100143). Spec test
 * #1 ("Confirmed item can be opened and edited") and the archive-
 * dependency-visibility half of test #20/#11 live here.
 *
 * NOTE: 20260811100144/100145 originally also widened list_admin_items/
 * get_admin_item to surface NON_INVENTORY (expense) rows -- reverted by
 * 20260811100147 because tests/adminItemMaster.rpc.test.ts already had a
 * dedicated, deliberately-named test proving the Admin Item Master
 * surface must NEVER show NON_INVENTORY rows (a different domain concept
 * with no balance/vendor-package/base-unit/usage-units). The tests below
 * assert that exclusion, not a disposition filter parameter that no
 * longer exists.
 */

let fx: RpcTestFixtures;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

function uniqueName(label: string): string {
  return `TEST Workspace Item ${label} ${randomUUID().slice(0, 8)}`;
}

describe("get_admin_item -- widened fields (disposition, spend category, default receiving location)", () => {
  it("a freshly-created item can be opened via get_admin_item and shows the widened fields with sensible defaults", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("Open"), categoryId, fx.noRuleUnitId);
    const fetched = await getAdminItem(fx.supabase, fx.organizationId, created.itemId);
    expect(fetched).not.toBeNull();
    expect(fetched?.disposition).toBe("INVENTORY");
    expect(fetched?.spendCategoryId).toBeNull();
    expect(fetched?.defaultReceivingLocationId).toBeNull();
  });
});

describe("list_admin_items -- INVENTORY-only scope (never surfaces expense rows)", () => {
  it("returns a freshly-created inventory item", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("DispositionDefault"), categoryId, fx.noRuleUnitId);
    const listed = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: created.itemNumber });
    expect(listed.some((i) => i.itemId === created.itemId)).toBe(true);
  });

  it("never returns a NON_INVENTORY (expense) item", async () => {
    // A confirmed NON_INVENTORY item, via the existing classification
    // pipeline (Admin Item Master's own create_admin_item is INVENTORY-
    // only by construction -- expense items are only ever created via
    // classification).
    const runTag = randomUUID().slice(0, 8);
    const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `EXP-${runTag}`, description: `Expense Workspace Item ${runTag}`, packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const finalName = `TEST Expense Workspace Item ${runTag}`;
    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const listed = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: finalName });
    expect(listed.some((i) => i.itemId === result.inventoryItemId)).toBe(false);

    const fetched = await getAdminItem(fx.supabase, fx.organizationId, result.inventoryItemId);
    expect(fetched).toBeNull();
  });
});

describe("get_admin_item_archive_dependencies -- read-only visibility (spec section 11)", () => {
  it("a brand-new item with no stock, mappings, usage units, or open documents reports all dependency counts as zero/false", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("NoDeps"), categoryId, fx.noRuleUnitId);
    const dependencies = await getAdminItemArchiveDependencies(fx.supabase, fx.organizationId, created.itemId);
    expect(dependencies.hasPositiveStock).toBe(false);
    expect(dependencies.positiveStockLocations).toHaveLength(0);
    expect(dependencies.activeVendorMappingCount).toBe(0);
    expect(dependencies.activeUsageUnitCount).toBe(0);
    expect(dependencies.openDocumentLineCount).toBe(0);
  });

  it("counts an active vendor mapping and an open (DRAFT) document line referencing the item", async () => {
    const runTag = randomUUID().slice(0, 8);
    const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `DEP-${runTag}`, description: `Dependency Test Item ${runTag}`, packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const result = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Dependency Test Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      rememberVendorMapping: true,
    });

    // The document is still DRAFT (never submitted/verified) -- an open
    // document line referencing this item.
    const dependencies = await getAdminItemArchiveDependencies(fx.supabase, fx.organizationId, result.inventoryItemId);
    expect(dependencies.hasPositiveStock).toBe(false);
    expect(dependencies.activeVendorMappingCount).toBe(1);
    expect(dependencies.openDocumentLineCount).toBe(1);
  });
});
