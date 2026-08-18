import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createInventoryCategoryRpc,
  renameInventoryCategoryRpc,
  setInventoryCategoryActiveRpc,
  createSpendCategoryRpc,
  renameSpendCategoryRpc,
  setSpendCategoryActiveRpc,
} from "@/app/lib/itemMaster/createCategoryRpc";
import { CategoryAlreadyExistsError } from "@/app/lib/itemMaster/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the /manager/settings/categories admin RPCs (20260811100048)
 * against real Postgres: create/rename/activate/deactivate for both
 * inventory and spend categories, duplicate-name rejection on rename, and
 * that every write is audited.
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("category settings RPCs", () => {
  it("renames an inventory category and audits it", async () => {
    const original = `TEST Settings Category ${randomUUID().slice(0, 8)}`;
    const renamed = `${original} Renamed`;
    const { categoryId } = await createInventoryCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: original });

    await renameInventoryCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, newName: renamed });

    const { data: row } = await fx.supabase.from("inventory_categories").select("name").eq("id", categoryId).single();
    expect(row!.name).toBe(renamed);

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("action, before_state, after_state")
      .eq("entity_id", categoryId)
      .eq("action", "INVENTORY_CATEGORY_RENAMED")
      .single();
    expect(audit!.before_state).toMatchObject({ name: original });
    expect(audit!.after_state).toMatchObject({ name: renamed });
  });

  it("rejects renaming an inventory category to a name that already exists", async () => {
    const nameA = `TEST Settings Dup A ${randomUUID().slice(0, 8)}`;
    const nameB = `TEST Settings Dup B ${randomUUID().slice(0, 8)}`;
    await createInventoryCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: nameA });
    const { categoryId: idB } = await createInventoryCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: nameB });

    await expect(
      renameInventoryCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId: idB, newName: nameA })
    ).rejects.toBeInstanceOf(CategoryAlreadyExistsError);
  });

  it("deactivates and reactivates an inventory category, auditing both", async () => {
    const { categoryId } = await createInventoryCategoryRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      name: `TEST Settings Toggle ${randomUUID().slice(0, 8)}`,
    });

    await setInventoryCategoryActiveRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, isActive: false });
    let { data: row } = await fx.supabase.from("inventory_categories").select("is_active").eq("id", categoryId).single();
    expect(row!.is_active).toBe(false);

    await setInventoryCategoryActiveRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, isActive: true });
    ({ data: row } = await fx.supabase.from("inventory_categories").select("is_active").eq("id", categoryId).single());
    expect(row!.is_active).toBe(true);

    const { data: audits } = await fx.supabase
      .from("audit_events")
      .select("action")
      .eq("entity_id", categoryId)
      .in("action", ["INVENTORY_CATEGORY_ACTIVATED", "INVENTORY_CATEGORY_DEACTIVATED"]);
    expect(audits!.map((a) => a.action).sort()).toEqual(["INVENTORY_CATEGORY_ACTIVATED", "INVENTORY_CATEGORY_DEACTIVATED"]);
  });

  it("renames a spend category, respecting per-level (not global) duplicate checking", async () => {
    const rootName = `TEST Settings Spend Root ${randomUUID().slice(0, 8)}`;
    const { categoryId: rootId } = await createSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: rootName, parentId: null });

    const childName = `TEST Settings Spend Child ${randomUUID().slice(0, 8)}`;
    const { categoryId: childId } = await createSpendCategoryRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      name: childName,
      parentId: rootId,
    });

    // Renaming the child to the SAME name as the root is fine -- different levels.
    await renameSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId: childId, newName: rootName });
    const { data: row } = await fx.supabase.from("spend_categories").select("name").eq("id", childId).single();
    expect(row!.name).toBe(rootName);
  });

  it("deactivates a spend category", async () => {
    const { categoryId } = await createSpendCategoryRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      name: `TEST Settings Spend Toggle ${randomUUID().slice(0, 8)}`,
      parentId: null,
    });

    await setSpendCategoryActiveRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, isActive: false });
    const { data: row } = await fx.supabase.from("spend_categories").select("is_active").eq("id", categoryId).single();
    expect(row!.is_active).toBe(false);
  });
});
