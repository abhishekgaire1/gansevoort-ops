import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setInventoryItemDefaultReceivingLocationRpc } from "@/app/lib/itemMaster/setInventoryItemDefaultReceivingLocationRpc";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Direct tests of set_inventory_item_default_receiving_location
 * (20260811100053) against real Postgres -- "where does this item
 * normally go when received," a manager-editable convenience prefill,
 * never authoritative on its own, and never confused with historical
 * receipt_lines.location_id facts.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
let locationA: string;
let locationB: string;

async function findOrCreateNamedLocation(name: string): Promise<string> {
  const { data: existing } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).eq("name", name).maybeSingle();
  if (existing) return existing.id as string;
  const { data: created } = await fx.supabase
    .from("locations")
    // is_storage_eligible explicit, never relying on the (now false) DB
    // default -- 20260811100073.
    .insert({ organization_id: fx.organizationId, name, timezone: "America/New_York", is_storage_eligible: true })
    .select("id")
    .single();
  return created!.id as string;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);

  // Two explicitly, stably named test locations -- never derived from
  // "whatever sorts first" among the org's existing locations, which
  // silently collided with itself on a second run once its own
  // previously-created row was already present.
  locationA = await findOrCreateNamedLocation("TEST Default Receiving Location A");
  locationB = await findOrCreateNamedLocation("TEST Default Receiving Location B");
});

async function currentDefault(inventoryItemId: string): Promise<string | null> {
  const { data } = await fx.supabase.from("inventory_items").select("default_receiving_location_id").eq("id", inventoryItemId).single();
  return (data?.default_receiving_location_id as string | null) ?? null;
}

async function auditCount(inventoryItemId: string): Promise<number> {
  const { count } = await fx.supabase
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", inventoryItemId)
    .eq("action", "INVENTORY_ITEM_DEFAULT_RECEIVING_LOCATION_CHANGED");
  return count ?? 0;
}

describe("set_inventory_item_default_receiving_location", () => {
  it("sets the item's default receiving location the first time, auditing the change from null", async () => {
    const { data: item } = await fx.supabase
      .from("inventory_items")
      .insert({ organization_id: fx.organizationId, name: `TEST Default Location Item ${randomUUID().slice(0, 8)}`, category_id: null, base_unit_id: fx.noRuleUnitId, disposition: "NON_INVENTORY" })
      .select("id")
      .single();
    const itemId = item!.id as string;

    expect(await currentDefault(itemId)).toBeNull();

    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: itemId,
      locationId: locationA,
    });

    expect(await currentDefault(itemId)).toBe(locationA);
    expect(await auditCount(itemId)).toBe(1);

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("before_state, after_state")
      .eq("entity_id", itemId)
      .eq("action", "INVENTORY_ITEM_DEFAULT_RECEIVING_LOCATION_CHANGED")
      .single();
    expect(audit!.before_state).toEqual({ locationId: null });
    expect(audit!.after_state).toEqual({ locationId: locationA });
  });

  it("updates the default when a manager confirms a different location, auditing the change -- and is a quiet no-op (no write, no audit) when the location isn't actually changing", async () => {
    const { data: item } = await fx.supabase
      .from("inventory_items")
      .insert({ organization_id: fx.organizationId, name: `TEST Default Location Change ${randomUUID().slice(0, 8)}`, category_id: null, base_unit_id: fx.noRuleUnitId, disposition: "NON_INVENTORY" })
      .select("id")
      .single();
    const itemId = item!.id as string;

    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: itemId, locationId: locationA });
    expect(await currentDefault(itemId)).toBe(locationA);

    // Re-confirming the SAME location: no second audit event, no-op.
    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: itemId, locationId: locationA });
    expect(await auditCount(itemId)).toBe(1);

    // Changing to a genuinely different location: updates and audits.
    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: itemId, locationId: locationB });
    expect(await currentDefault(itemId)).toBe(locationB);
    expect(await auditCount(itemId)).toBe(2);
  });

  it("different items remember different locations independently", async () => {
    const { data: itemX } = await fx.supabase
      .from("inventory_items")
      .insert({ organization_id: fx.organizationId, name: `TEST Default Location Item X ${randomUUID().slice(0, 8)}`, category_id: null, base_unit_id: fx.noRuleUnitId, disposition: "NON_INVENTORY" })
      .select("id")
      .single();
    const { data: itemY } = await fx.supabase
      .from("inventory_items")
      .insert({ organization_id: fx.organizationId, name: `TEST Default Location Item Y ${randomUUID().slice(0, 8)}`, category_id: null, base_unit_id: fx.noRuleUnitId, disposition: "NON_INVENTORY" })
      .select("id")
      .single();

    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: itemX!.id as string, locationId: locationA });
    await setInventoryItemDefaultReceivingLocationRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: itemY!.id as string, locationId: locationB });

    expect(await currentDefault(itemX!.id as string)).toBe(locationA);
    expect(await currentDefault(itemY!.id as string)).toBe(locationB);
  });

  it("rejects a location that does not belong to the organization (or does not exist at all)", async () => {
    await expect(
      setInventoryItemDefaultReceivingLocationRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        inventoryItemId: fx.noRuleItemId,
        locationId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("rejects an inventory_item that does not belong to the organization", async () => {
    await expect(
      setInventoryItemDefaultReceivingLocationRpc(fx.supabase, {
        organizationId: otherOrg.organizationId,
        appUserId: otherOrg.appUserId,
        inventoryItemId: fx.noRuleItemId,
        locationId: locationA,
      })
    ).rejects.toThrow();
  });
});
