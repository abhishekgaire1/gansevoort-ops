import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header.
 * Proves the storage-location admin RPCs (20260811100180) against real
 * Postgres: create/rename, storage-eligibility, activate/deactivate with
 * the has-stock + default guards, set-default validation, the admin
 * overview, and cross-org isolation.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

function locName() {
  return `TEST Location ${randomUUID().slice(0, 8)}`;
}

async function createLocation(name: string, storageEligible = true): Promise<string> {
  const { data, error } = await fx.supabase.rpc("create_location", {
    p_organization_id: fx.organizationId,
    p_actor_app_user_id: fx.changeableEmployeeAppUserId,
    p_name: name,
    p_is_storage_eligible: storageEligible,
  });
  expect(error).toBeNull();
  return (data as { out_location_id: string }[])[0].out_location_id;
}

describe("create_location", () => {
  it("creates an active location and audits LOCATION_CREATED", async () => {
    const name = locName();
    const id = await createLocation(name);
    const { data: row } = await fx.supabase.from("locations").select("name, is_active, is_storage_eligible, is_default").eq("id", id).single();
    expect(row!.name).toBe(name);
    expect(row!.is_active).toBe(true);
    expect(row!.is_storage_eligible).toBe(true);
    expect(row!.is_default).toBe(false); // never created as default
    const { data: audit } = await fx.supabase.from("audit_events").select("action").eq("entity_id", id).eq("action", "LOCATION_CREATED").maybeSingle();
    expect(audit).not.toBeNull();
  });

  it("rejects a duplicate name with GA082", async () => {
    const name = locName();
    await createLocation(name);
    const { error } = await fx.supabase.rpc("create_location", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: `  ${name.toUpperCase()}  `,
    });
    expect(error!.code).toBe("GA082");
  });
});

describe("update_location_name", () => {
  it("renames a location", async () => {
    const id = await createLocation(locName());
    const newName = locName();
    const { error } = await fx.supabase.rpc("update_location_name", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_location_id: id,
      p_name: newName,
    });
    expect(error).toBeNull();
    const { data: row } = await fx.supabase.from("locations").select("name").eq("id", id).single();
    expect(row!.name).toBe(newName);
  });

  it("returns GA034 for a location in another organization", async () => {
    const id = await createLocation(locName());
    const { error } = await fx.supabase.rpc("update_location_name", {
      p_organization_id: otherOrg.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_location_id: id,
      p_name: locName(),
    });
    expect(error!.code).toBe("GA034");
  });
});

describe("set_default_location", () => {
  it("only allows an active, storage-eligible location to be default (GA085 otherwise)", async () => {
    const nonStorage = await createLocation(locName(), false);
    const { error } = await fx.supabase.rpc("set_default_location", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_location_id: nonStorage,
    });
    expect(error!.code).toBe("GA085");
  });

  it("moves the default and unsets the previous one (only one default per org)", async () => {
    const a = await createLocation(locName());
    const b = await createLocation(locName());
    await fx.supabase.rpc("set_default_location", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: a });
    await fx.supabase.rpc("set_default_location", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: b });
    const { data: rows } = await fx.supabase.from("locations").select("id, is_default").in("id", [a, b]);
    expect(rows!.find((r) => r.id === a)!.is_default).toBe(false);
    expect(rows!.find((r) => r.id === b)!.is_default).toBe(true);
    const { count } = await fx.supabase.from("locations").select("*", { count: "exact", head: true }).eq("organization_id", fx.organizationId).eq("is_default", true);
    expect(count).toBe(1);
  });
});

describe("set_location_status / set_location_storage_eligible guards", () => {
  it("blocks deactivating the default location with GA084", async () => {
    const id = await createLocation(locName());
    await fx.supabase.rpc("set_default_location", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id });
    const { error } = await fx.supabase.rpc("set_location_status", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id, p_is_active: false });
    expect(error!.code).toBe("GA084");
  });

  it("blocks removing storage eligibility from the default location with GA084", async () => {
    const id = await createLocation(locName());
    await fx.supabase.rpc("set_default_location", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id });
    const { error } = await fx.supabase.rpc("set_location_storage_eligible", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id, p_is_storage_eligible: false });
    expect(error!.code).toBe("GA084");
  });

  it("deactivates a non-default location with no stock", async () => {
    const id = await createLocation(locName());
    const { error } = await fx.supabase.rpc("set_location_status", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id, p_is_active: false });
    expect(error).toBeNull();
    const { data: row } = await fx.supabase.from("locations").select("is_active").eq("id", id).single();
    expect(row!.is_active).toBe(false);
  });

  it("blocks deactivating a location that still holds stock with GA083", async () => {
    const id = await createLocation(locName());
    // Insert a PURCHASE_RECEIPT movement + line so the location holds stock.
    const { data: mv, error: mErr } = await fx.supabase
      .from("inventory_movements")
      .insert({ organization_id: fx.organizationId, location_id: id, movement_type: "PURCHASE_RECEIPT", performed_by_app_user_id: fx.changeableEmployeeAppUserId })
      .select("id")
      .single();
    expect(mErr).toBeNull();
    const { error: lErr } = await fx.supabase.from("inventory_movement_lines").insert({
      movement_id: mv!.id,
      organization_id: fx.organizationId,
      inventory_item_id: fx.noRuleItemId,
      entered_quantity: 10,
      entered_unit_id: fx.noRuleUnitId,
      base_unit_id: fx.noRuleUnitId,
      normalized_base_quantity: 10,
    });
    expect(lErr).toBeNull();

    const { data: hasStock } = await fx.supabase.rpc("location_has_stock", { p_organization_id: fx.organizationId, p_location_id: id });
    expect(hasStock).toBe(true);

    const { error } = await fx.supabase.rpc("set_location_status", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_location_id: id, p_is_active: false });
    expect(error!.code).toBe("GA083");
  });
});

describe("list_admin_locations", () => {
  it("returns each location with dependency signals", async () => {
    const id = await createLocation(locName());
    const { data, error } = await fx.supabase.rpc("list_admin_locations", { p_organization_id: fx.organizationId });
    expect(error).toBeNull();
    const row = (data as { out_id: string; out_has_stock: boolean; out_movement_count: number }[]).find((r) => r.out_id === id);
    expect(row).toBeDefined();
    expect(row!.out_has_stock).toBe(false);
    expect(Number(row!.out_movement_count)).toBe(0);
  });
});
