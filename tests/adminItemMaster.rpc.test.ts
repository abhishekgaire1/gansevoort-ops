import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import {
  listAdminItems,
  getAdminItem,
  createAdminItem,
  updateAdminItemDetails,
  setAdminItemBaseUnit,
  setAdminItemStatus,
  findSimilarItems,
  bulkImportAdminItems,
} from "@/app/lib/admin/items";
import { AdminActionError } from "@/app/lib/admin/errors";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminFoundation.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows: not run by `npm test`, run explicitly).
 *
 * Canonical Item Master + Inventory Relevance Classification milestone
 * (20260811100098) -- exercises the NEW Admin-only browse/create/rename/
 * base-unit-change/deactivate-reactivate/bulk-import/similarity-search
 * RPCs against the real linked dev database. The pre-existing
 * classify-then-match/vendor-mapping/posting pipeline these build on top
 * of is already covered by completionGate.rpc.test.ts,
 * classificationApprovalGuards.rpc.test.ts, inventoryPosting.rpc.test.ts,
 * etc. and is intentionally NOT re-tested here.
 */

let fx: RpcTestFixtures;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

function uniqueName(label: string): string {
  return `TEST Admin Item ${label} ${randomUUID().slice(0, 8)}`;
}

describe("createAdminItem / listAdminItems / getAdminItem", () => {
  it("creates an item with a stable, server-generated, sequential-looking item number", async () => {
    const name = uniqueName("Create");
    const result = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name, categoryId, fx.noRuleUnitId);
    expect(result.itemId).toBeTruthy();
    expect(result.itemNumber).toMatch(/^ITEM-\d{6}$/);

    const fetched = await getAdminItem(fx.supabase, fx.organizationId, result.itemId);
    expect(fetched?.name).toBe(name);
    expect(fetched?.itemNumber).toBe(result.itemNumber);
    expect(fetched?.status).toBe("active");
    expect(fetched?.hasMovementHistory).toBe(false);

    const listed = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: name });
    expect(listed.some((i) => i.itemId === result.itemId)).toBe(true);
  });

  it("rejects an exact-duplicate active name with a clean, detail-carrying error", async () => {
    const name = uniqueName("Dup");
    await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name, categoryId, fx.noRuleUnitId);

    await expect(createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name, categoryId, fx.noRuleUnitId)).rejects.toMatchObject({
      code: "DUPLICATE_ITEM_NAME",
    });
  });

  it("rejects an invalid/inactive category and an unknown unit", async () => {
    await expect(createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("BadCat"), randomUUID(), fx.noRuleUnitId)).rejects.toMatchObject({
      code: "INVALID_CATEGORY",
    });
    await expect(createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("BadUnit"), categoryId, randomUUID())).rejects.toMatchObject({
      code: "INVALID_BASE_UNIT",
    });
  });

  it("concurrent creation of two DIFFERENTLY-named items in the same org never collides on item number", async () => {
    const nameA = uniqueName("ConcurrentA");
    const nameB = uniqueName("ConcurrentB");
    const [a, b] = await Promise.all([
      createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, nameA, categoryId, fx.noRuleUnitId),
      createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, nameB, categoryId, fx.noRuleUnitId),
    ]);
    expect(a.itemNumber).not.toBe(b.itemNumber);
  });

  it("cross-org isolation: another organization's item is never listed/gettable", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const { data: otherCategory } = await fx.supabase.from("inventory_categories").select("id").eq("organization_id", other.organizationId).limit(1).maybeSingle();
    let otherCategoryId = otherCategory?.id as string | undefined;
    if (!otherCategoryId) {
      const { data: created } = await fx.supabase.from("inventory_categories").insert({ organization_id: other.organizationId, name: `TEST OrgB Category ${randomUUID().slice(0, 6)}` }).select("id").single();
      otherCategoryId = created!.id as string;
    }
    const { data: unit } = await fx.supabase.from("units").select("id").limit(1).single();

    const name = uniqueName("OrgB");
    const result = await createAdminItem(fx.supabase, other.organizationId, other.appUserId, name, otherCategoryId, unit!.id as string);

    const fetchedFromWrongOrg = await getAdminItem(fx.supabase, fx.organizationId, result.itemId);
    expect(fetchedFromWrongOrg).toBeNull();

    // Search by NAME, not item_number -- item numbers restart at 1 per
    // organization by design (Part 9: "organization-scoped"), so two
    // different orgs' items can legitimately share the same item_number
    // text; that is not a cross-org leak.
    const listedFromWrongOrg = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: name });
    expect(listedFromWrongOrg).toHaveLength(0);
  });
});

describe("updateAdminItemDetails -- rename preserves id/item number", () => {
  it("renames and changes category without touching id or item number", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("Rename"), categoryId, fx.noRuleUnitId);
    const newName = uniqueName("Renamed");
    await updateAdminItemDetails(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.itemId, newName, categoryId);

    const fetched = await getAdminItem(fx.supabase, fx.organizationId, created.itemId);
    expect(fetched?.itemId).toBe(created.itemId);
    expect(fetched?.itemNumber).toBe(created.itemNumber);
    expect(fetched?.name).toBe(newName);
  });

  it("rejects renaming into a collision with another active item", async () => {
    const nameA = uniqueName("CollideA");
    const nameB = uniqueName("CollideB");
    await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, nameA, categoryId, fx.noRuleUnitId);
    const itemB = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, nameB, categoryId, fx.noRuleUnitId);

    await expect(updateAdminItemDetails(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, itemB.itemId, nameA, categoryId)).rejects.toMatchObject({
      code: "DUPLICATE_ITEM_NAME",
    });
  });
});

describe("setAdminItemBaseUnit -- guarded by movement history", () => {
  it("allows a base unit change for an item with no movement history", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("UnitChange"), categoryId, fx.noRuleUnitId);
    await expect(setAdminItemBaseUnit(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.itemId, fx.volumeUnitId)).resolves.not.toThrow();
    const fetched = await getAdminItem(fx.supabase, fx.organizationId, created.itemId);
    expect(fetched?.baseUnitId).toBe(fx.volumeUnitId);
  });

  it("blocks a base unit change for an item that already has inventory movement history", async () => {
    // fx.variableWeightItemId has real movement history from withdrawal.rpc.test.ts's own fixtures.
    await expect(setAdminItemBaseUnit(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, fx.variableWeightItemId, fx.volumeUnitId)).rejects.toMatchObject({
      code: "BASE_UNIT_CHANGE_BLOCKED_HISTORY",
    });
  });
});

describe("setAdminItemStatus -- deactivate/reactivate, no hard delete", () => {
  it("deactivates and reactivates an item with no stock", async () => {
    const created = await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("Status"), categoryId, fx.noRuleUnitId);
    await setAdminItemStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.itemId, "inactive");
    let fetched = await getAdminItem(fx.supabase, fx.organizationId, created.itemId);
    expect(fetched?.status).toBe("inactive");
    expect(fetched?.itemId).toBe(created.itemId);

    await setAdminItemStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.itemId, "active");
    fetched = await getAdminItem(fx.supabase, fx.organizationId, created.itemId);
    expect(fetched?.status).toBe("active");
    expect(fetched?.itemId).toBe(created.itemId); // same identity, never recreated
  });
});

describe("findSimilarActiveItems", () => {
  it("finds an exact match and a fuzzy possible-duplicate, excludes unrelated items", async () => {
    const base = uniqueName("Fuzzy Heavy Cream");
    await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, base, categoryId, fx.noRuleUnitId);

    const exact = await findSimilarItems(fx.supabase, fx.organizationId, base);
    expect(exact.some((c) => c.name === base && c.isExact)).toBe(true);

    const fuzzyQuery = base.replace("Heavy Cream", "Heavy Whipping Cream");
    const fuzzy = await findSimilarItems(fx.supabase, fx.organizationId, fuzzyQuery);
    expect(fuzzy.some((c) => c.name === base && !c.isExact)).toBe(true);

    const unrelated = await findSimilarItems(fx.supabase, fx.organizationId, `Completely Unrelated ${randomUUID()}`);
    expect(unrelated).toHaveLength(0);
  });
});

describe("bulkImportAdminItems -- row-independent, no all-or-nothing failure", () => {
  it("imports valid rows, skips exact duplicates, rejects invalid rows -- all in one call", async () => {
    const existingName = uniqueName("BulkExisting");
    await createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, existingName, categoryId, fx.noRuleUnitId);

    const freshName = uniqueName("BulkFresh");
    const results = await bulkImportAdminItems(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, "test.csv", [
      { rowIndex: 1, name: freshName, categoryId, baseUnitId: fx.noRuleUnitId },
      { rowIndex: 2, name: existingName, categoryId, baseUnitId: fx.noRuleUnitId },
      { rowIndex: 3, name: "", categoryId, baseUnitId: fx.noRuleUnitId },
    ]);

    expect(results.find((r) => r.rowIndex === 1)?.outcome).toBe("IMPORTED");
    expect(results.find((r) => r.rowIndex === 2)?.outcome).toBe("DUPLICATE_SKIPPED");
    expect(results.find((r) => r.rowIndex === 3)?.outcome).toBe("REJECTED");

    const listed = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: freshName });
    expect(listed.some((i) => i.name === freshName)).toBe(true);
  });

  it("preserves an explicitly supplied item number and rejects a collision with an already-used one", async () => {
    const explicitNumber = `ITEM-TEST-${randomUUID().slice(0, 6).toUpperCase()}`;
    const results = await bulkImportAdminItems(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, "test.csv", [
      { rowIndex: 1, itemNumber: explicitNumber, name: uniqueName("ExplicitNumber"), categoryId, baseUnitId: fx.noRuleUnitId },
    ]);
    expect(results[0].outcome).toBe("IMPORTED");
    expect(results[0].itemNumber).toBe(explicitNumber);

    const collision = await bulkImportAdminItems(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, "test.csv", [
      { rowIndex: 1, itemNumber: explicitNumber, name: uniqueName("CollidingNumber"), categoryId, baseUnitId: fx.noRuleUnitId },
    ]);
    expect(collision[0].outcome).toBe("REJECTED");
  });

  it("a durable import summary is recorded", async () => {
    const before = await fx.supabase.from("canonical_item_bulk_imports").select("id").eq("organization_id", fx.organizationId);
    await bulkImportAdminItems(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, "summary-test.csv", [
      { rowIndex: 1, name: uniqueName("SummaryTest"), categoryId, baseUnitId: fx.noRuleUnitId },
    ]);
    const after = await fx.supabase.from("canonical_item_bulk_imports").select("id, rows_parsed, rows_imported").eq("organization_id", fx.organizationId);
    expect((after.data?.length ?? 0)).toBeGreaterThan(before.data?.length ?? 0);
  });

  it("cross-org safe: bulk import never creates or collides with another organization's items", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const { data: otherUnit } = await fx.supabase.from("units").select("id").limit(1).single();
    const { data: otherCategory } = await fx.supabase.from("inventory_categories").select("id").eq("organization_id", other.organizationId).limit(1).maybeSingle();
    let otherCategoryId = otherCategory?.id as string | undefined;
    if (!otherCategoryId) {
      const { data: created } = await fx.supabase.from("inventory_categories").insert({ organization_id: other.organizationId, name: `TEST OrgB Bulk Category ${randomUUID().slice(0, 6)}` }).select("id").single();
      otherCategoryId = created!.id as string;
    }
    const name = uniqueName("CrossOrgBulk");
    await bulkImportAdminItems(fx.supabase, other.organizationId, other.appUserId, "orgb.csv", [{ rowIndex: 1, name, categoryId: otherCategoryId, baseUnitId: otherUnit!.id as string }]);

    const listedFromWrongOrg = await listAdminItems(fx.supabase, { organizationId: fx.organizationId, search: name });
    expect(listedFromWrongOrg).toHaveLength(0);
  });
});

describe("Non-inventory / pending-review items never appear in the Admin Item Master surfaces", () => {
  it("a PENDING_REVIEW AI proposal is never listed/gettable via the admin surface", async () => {
    const { data: pending } = await fx.supabase
      .from("inventory_items")
      .insert({
        organization_id: fx.organizationId,
        category_id: categoryId,
        name: uniqueName("PendingProposal"),
        base_unit_id: fx.noRuleUnitId,
        status: "active",
        disposition: "INVENTORY",
        approval_status: "PENDING_REVIEW",
        created_via: "AI_PROPOSED",
      })
      .select("id")
      .single();

    const fetched = await getAdminItem(fx.supabase, fx.organizationId, pending!.id as string);
    expect(fetched).toBeNull();
  });

  it("a confirmed NON_INVENTORY expense-classification row is never listed/gettable via the admin surface", async () => {
    const { data: expense } = await fx.supabase
      .from("inventory_items")
      .insert({
        organization_id: fx.organizationId,
        name: uniqueName("ExpenseRow"),
        status: "active",
        disposition: "NON_INVENTORY",
        approval_status: "CONFIRMED",
        created_via: "MANUAL",
      })
      .select("id")
      .single();

    const fetched = await getAdminItem(fx.supabase, fx.organizationId, expense!.id as string);
    expect(fetched).toBeNull();
  });
});

describe("Server-side error mapping never throws AdminActionError for unrelated failures", () => {
  it("mapAdminRpcError wraps a genuine RPC error into a typed AdminActionError", async () => {
    await expect(createAdminItem(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, uniqueName("Err"), randomUUID(), fx.noRuleUnitId)).rejects.toBeInstanceOf(AdminActionError);
  });
});
