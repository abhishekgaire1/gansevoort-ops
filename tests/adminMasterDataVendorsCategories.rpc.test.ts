import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment. Proves the Admin Master Data milestone's new RPCs
 * (20260811100100) against real Postgres: Vendor create/update/
 * deactivate-reactivate/alias, the controlled Manager quick-create
 * exception, and category deactivation dependency-blocking.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

function vendorName() {
  return `TEST Admin Vendor ${randomUUID().slice(0, 8)}`;
}

describe("create_vendor_admin", () => {
  it("creates a vendor with full details and audits VENDOR_CREATED", async () => {
    const name = vendorName();
    const { data, error } = await fx.supabase.rpc("create_vendor_admin", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: name,
      p_legal_name: "Legal Co LLC",
      p_account_number: "ACC-1",
      p_contact_name: "Jane Doe",
      p_email: "jane@example.com",
      p_phone: "555-1234",
      p_notes: "Net 30",
    });
    expect(error).toBeNull();
    const vendorId = (data as { out_vendor_id: string }[])[0].out_vendor_id;

    const { data: row } = await fx.supabase.from("vendors").select("legal_name, account_number, is_active").eq("id", vendorId).single();
    expect(row!.legal_name).toBe("Legal Co LLC");
    expect(row!.account_number).toBe("ACC-1");
    expect(row!.is_active).toBe(true);

    const { data: audit } = await fx.supabase.from("audit_events").select("action").eq("entity_id", vendorId).eq("action", "VENDOR_CREATED").maybeSingle();
    expect(audit).not.toBeNull();
  });

  it("blocks an exact normalized-duplicate name with GA052, carrying the existing vendor's id/name in detail", async () => {
    const name = vendorName();
    await fx.supabase.rpc("create_vendor_admin", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_name: name });

    const { error } = await fx.supabase.rpc("create_vendor_admin", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: `  ${name.toLowerCase()}  `,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("GA052");
    const detail = JSON.parse(error!.details as string) as { existingVendorName: string };
    expect(detail.existingVendorName).toBe(name);
  });

  it("never lets a duplicate check in one org match a vendor belonging to a different org", async () => {
    const { error } = await fx.supabase.rpc("create_vendor_admin", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: (await fx.supabase.from("vendors").select("name").eq("id", otherOrg.vendorId).single()).data!.name as string,
    });
    expect(error).toBeNull();
  });
});

describe("update_vendor_details -- rename preserves the same Vendor ID", () => {
  it("renames in place, never creating a new row, and audits VENDOR_RENAMED", async () => {
    const original = vendorName();
    const renamed = `${original} Renamed`;
    const { data } = await fx.supabase.rpc("create_vendor_admin", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_name: original });
    const vendorId = (data as { out_vendor_id: string }[])[0].out_vendor_id;

    const { error } = await fx.supabase.rpc("update_vendor_details", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_vendor_id: vendorId,
      p_name: renamed,
    });
    expect(error).toBeNull();

    const { data: row } = await fx.supabase.from("vendors").select("id, name").eq("id", vendorId).single();
    expect(row!.id).toBe(vendorId);
    expect(row!.name).toBe(renamed);

    const { data: audit } = await fx.supabase.from("audit_events").select("before_state, after_state").eq("entity_id", vendorId).eq("action", "VENDOR_RENAMED").single();
    expect(audit!.before_state).toMatchObject({ name: original });
    expect(audit!.after_state).toMatchObject({ name: renamed });
  });
});

describe("set_vendor_active -- deactivate/reactivate, no hard delete", () => {
  it("deactivates then reactivates the SAME vendor, auditing both, id/name unchanged", async () => {
    const name = vendorName();
    const { data } = await fx.supabase.rpc("create_vendor_admin", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_name: name });
    const vendorId = (data as { out_vendor_id: string }[])[0].out_vendor_id;

    await fx.supabase.rpc("set_vendor_active", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_vendor_id: vendorId, p_is_active: false });
    let { data: row } = await fx.supabase.from("vendors").select("id, name, is_active").eq("id", vendorId).single();
    expect(row!.is_active).toBe(false);

    await fx.supabase.rpc("set_vendor_active", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_vendor_id: vendorId, p_is_active: true });
    ({ data: row } = await fx.supabase.from("vendors").select("id, name, is_active").eq("id", vendorId).single());
    expect(row!.id).toBe(vendorId);
    expect(row!.name).toBe(name);
    expect(row!.is_active).toBe(true);

    const { data: audits } = await fx.supabase.from("audit_events").select("action").eq("entity_id", vendorId).in("action", ["VENDOR_REACTIVATED", "VENDOR_DEACTIVATED"]);
    expect(audits!.map((a) => a.action).sort()).toEqual(["VENDOR_DEACTIVATED", "VENDOR_REACTIVATED"]);
  });
});

describe("add_vendor_alias / remove_vendor_alias", () => {
  it("adds an alias and rejects a duplicate normalized alias with GA053", async () => {
    const { data } = await fx.supabase.rpc("create_vendor_admin", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_name: vendorName() });
    const vendorId = (data as { out_vendor_id: string }[])[0].out_vendor_id;
    const alias = `ALIAS ${randomUUID().slice(0, 8)}`;

    const { data: aliasData, error: aliasError } = await fx.supabase.rpc("add_vendor_alias", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_vendor_id: vendorId,
      p_alias: alias,
    });
    expect(aliasError).toBeNull();
    const aliasId = (aliasData as { out_alias_id: string }[])[0].out_alias_id;

    const { error: dupError } = await fx.supabase.rpc("add_vendor_alias", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_vendor_id: vendorId,
      p_alias: `  ${alias.toLowerCase()}  `,
    });
    expect(dupError).not.toBeNull();
    expect(dupError!.code).toBe("GA053");

    const { error: removeError } = await fx.supabase.rpc("remove_vendor_alias", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_alias_id: aliasId,
    });
    expect(removeError).toBeNull();
    const { data: row } = await fx.supabase.from("vendor_aliases").select("id").eq("id", aliasId).maybeSingle();
    expect(row).toBeNull();
  });
});

describe("create_vendor_from_receiving -- the controlled Manager exception", () => {
  it("creates a vendor by name only and audits the RECEIVING_QUICK_CREATE source", async () => {
    const name = vendorName();
    const { data, error } = await fx.supabase.rpc("create_vendor_from_receiving", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_vendor_name: name,
    });
    expect(error).toBeNull();
    const vendorId = (data as { out_vendor_id: string; out_name: string }[])[0].out_vendor_id;

    const { data: audit } = await fx.supabase.from("audit_events").select("after_state").eq("entity_id", vendorId).eq("action", "VENDOR_CREATED").single();
    expect(audit!.after_state).toMatchObject({ source: "RECEIVING_QUICK_CREATE" });
  });

  it("blocks an exact duplicate the same way the Admin path does (GA052)", async () => {
    const name = vendorName();
    await fx.supabase.rpc("create_vendor_from_receiving", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_vendor_name: name });

    const { error } = await fx.supabase.rpc("create_vendor_from_receiving", { p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_vendor_name: name });
    expect(error!.code).toBe("GA052");
  });
});

describe("set_inventory_category_active -- deactivation blocked by active dependent items", () => {
  it("blocks deactivation with GA055 while an active CONFIRMED INVENTORY item still references the category, and succeeds once none do", async () => {
    const { data: catData } = await fx.supabase.rpc("create_inventory_category", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: `TEST Blocking Category ${randomUUID().slice(0, 8)}`,
    });
    const categoryId = (catData as { out_category_id: string }[])[0].out_category_id;

    const { data: unit } = await fx.supabase.from("units").select("id").eq("code", "LB").single();
    await fx.supabase.from("inventory_items").insert({
      organization_id: fx.organizationId,
      category_id: categoryId,
      base_unit_id: unit!.id,
      name: `TEST Blocking Item ${randomUUID().slice(0, 8)}`,
      status: "active",
      disposition: "INVENTORY",
      approval_status: "CONFIRMED",
      created_via: "MANUAL",
    });

    const { error: blockedError } = await fx.supabase.rpc("set_inventory_category_active", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_category_id: categoryId,
      p_is_active: false,
    });
    expect(blockedError).not.toBeNull();
    expect(blockedError!.code).toBe("GA055");

    await fx.supabase.from("inventory_items").update({ status: "inactive" }).eq("category_id", categoryId);

    const { error: okError } = await fx.supabase.rpc("set_inventory_category_active", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_category_id: categoryId,
      p_is_active: false,
    });
    expect(okError).toBeNull();
  });
});

describe("set_spend_category_active -- deactivation blocked by active child categories only, never by historical usage alone", () => {
  it("blocks deactivating a parent with an active child (GA056), succeeds once the child is deactivated", async () => {
    const { data: rootData } = await fx.supabase.rpc("create_spend_category", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: `TEST Blocking Parent ${randomUUID().slice(0, 8)}`,
      p_parent_id: null,
    });
    const rootId = (rootData as { out_category_id: string }[])[0].out_category_id;

    const { data: childData } = await fx.supabase.rpc("create_spend_category", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_name: `TEST Blocking Child ${randomUUID().slice(0, 8)}`,
      p_parent_id: rootId,
    });
    const childId = (childData as { out_category_id: string }[])[0].out_category_id;

    const { error: blockedError } = await fx.supabase.rpc("set_spend_category_active", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_category_id: rootId,
      p_is_active: false,
    });
    expect(blockedError).not.toBeNull();
    expect(blockedError!.code).toBe("GA056");

    await fx.supabase.rpc("set_spend_category_active", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: childId, p_is_active: false });

    const { error: okError } = await fx.supabase.rpc("set_spend_category_active", {
      p_organization_id: fx.organizationId,
      p_app_user_id: fx.changeableEmployeeAppUserId,
      p_category_id: rootId,
      p_is_active: false,
    });
    expect(okError).toBeNull();
  });
});
