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
 * Proves the Admin -> Categories RPCs (20260811100048, flattened by the
 * Flat Category Architecture milestone's 20260811100102) against real
 * Postgres: create/rename/activate/deactivate for both inventory and
 * expense (spend_categories) categories, duplicate-name rejection, and
 * that every write is audited. Categories are ONE LEVEL ONLY (Part 1-3)
 * -- create_spend_category no longer accepts a parent, and duplicate
 * checking is flat/global per organization+type, not per-level.
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

  it("creates a flat expense category (no parent) and renames it, preserving its id", async () => {
    const original = `TEST Settings Spend Flat ${randomUUID().slice(0, 8)}`;
    const renamed = `${original} Renamed`;
    const { categoryId } = await createSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: original });

    const { data: created } = await fx.supabase.from("spend_categories").select("id, parent_id").eq("id", categoryId).single();
    expect(created!.parent_id).toBeNull();

    await renameSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, newName: renamed });
    const { data: row } = await fx.supabase.from("spend_categories").select("id, name").eq("id", categoryId).single();
    expect(row!.id).toBe(categoryId);
    expect(row!.name).toBe(renamed);
  });

  it("rejects an exact-duplicate expense category name within the same org -- flat/global, not per-level", async () => {
    const name = `TEST Settings Spend Dup ${randomUUID().slice(0, 8)}`;
    await createSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name });

    await expect(createSpendCategoryRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, name: `  ${name.toUpperCase()}  ` })).rejects.toBeInstanceOf(
      CategoryAlreadyExistsError
    );
  });

  it("deactivates and reactivates an expense category, auditing both, same id preserved", async () => {
    const { categoryId } = await createSpendCategoryRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      name: `TEST Settings Spend Toggle ${randomUUID().slice(0, 8)}`,
    });

    await setSpendCategoryActiveRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, isActive: false });
    let { data: row } = await fx.supabase.from("spend_categories").select("id, is_active").eq("id", categoryId).single();
    expect(row!.is_active).toBe(false);

    await setSpendCategoryActiveRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, categoryId, isActive: true });
    ({ data: row } = await fx.supabase.from("spend_categories").select("id, is_active").eq("id", categoryId).single());
    expect(row!.id).toBe(categoryId);
    expect(row!.is_active).toBe(true);
  });
});
