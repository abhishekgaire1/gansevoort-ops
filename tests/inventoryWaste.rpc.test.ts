import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { recordInventoryWaste, listInventoryWasteEvents, getInventoryWasteDetail } from "@/app/lib/inventory/waste";
import {
  InsufficientInventoryError,
  InvalidStorageLocationError,
  InvalidWasteQuantityError,
  InvalidWasteItemError,
  WasteNoteRequiredError,
  WasteRequestConflictError,
} from "@/app/lib/inventory/errors";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for the shared rationale.
 *
 * Standalone Inventory Waste (20260811100085_inventory_waste.sql):
 * known inventory loss from an EXACT physical storage location, before
 * that inventory is withdrawn to a station. Fresh storage location +
 * fresh item per test, same cross-talk-avoidance rationale as
 * cycleCountHistory.rpc.test.ts.
 *
 * Scenarios 27 ("manager/admin authorization") and 28 ("roleless
 * employee rejected") from the spec are NOT RPC-level tests: like every
 * other inventory RPC in this schema (record_inventory_withdrawal,
 * complete_cycle_count, etc.), record_inventory_waste trusts
 * p_recorded_by_app_user_id as already-authorized -- role gating happens
 * one layer up, in requireManagerOrAdmin() at the Server Action
 * (recordInventoryWasteAction), the SAME general-purpose guard every
 * other manager action already uses. There is no new authorization
 * mechanism introduced by this feature to test in isolation here.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
const MANAGER_A = () => fx.changeableEmployeeAppUserId;

async function createTestItem(baseUnitCode: "PIECE" | "LB"): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `IW-${tag}`, description: `Inventory Waste Test Item ${tag}`, packageUnit: baseUnitCode, packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Inventory Waste Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode,
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

async function createStorageLocation(organizationId: string, opts?: { isActive?: boolean; isStorageEligible?: boolean }): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { data, error } = await fx.supabase
    .from("locations")
    .insert({
      organization_id: organizationId,
      name: `TEST Waste Location ${tag}`,
      timezone: "America/New_York",
      is_active: opts?.isActive ?? true,
      is_storage_eligible: opts?.isStorageEligible ?? true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function receiveExact(inventoryItemId: string, baseUnitId: string, locationId: string, quantity: number): Promise<void> {
  const { data: movement, error: movementError } = await fx.supabase
    .from("inventory_movements")
    .insert({
      organization_id: fx.organizationId,
      location_id: locationId,
      station_id: null,
      movement_type: "PURCHASE_RECEIPT",
      performed_by_app_user_id: fx.changeableEmployeeAppUserId,
      business_date: new Date().toISOString().slice(0, 10),
      client_request_id: randomUUID(),
    })
    .select("id")
    .single();
  if (movementError) throw movementError;
  const { error: lineError } = await fx.supabase
    .from("inventory_movement_lines")
    .insert({ movement_id: movement!.id, inventory_item_id: inventoryItemId, entered_quantity: quantity, entered_unit_id: baseUnitId });
  if (lineError) throw lineError;
}

async function balanceAt(inventoryItemId: string, locationId: string): Promise<number> {
  const { data, error } = await fx.supabase.rpc("inventory_location_item_balance", {
    p_organization_id: fx.organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
  });
  if (error) throw error;
  return Number(data);
}

// Test-only, idempotent manager-role app_user -- same find-or-insert-
// with-23505-fallback pattern as cycleCountHistory.rpc.test.ts's
// ensureManagerRoleAppUser, since testFixtures.ts's private
// ensureEmployeeAppUser isn't exported and the shared TEST_ORG_NAME
// fixture persists across runs (never assume a clean slate).
async function ensureManagerRoleAppUser(employeeCode: string, firstName: string): Promise<string> {
  const { data: existingEmployee } = await fx.supabase
    .from("employees")
    .select("id")
    .eq("organization_id", fx.organizationId)
    .eq("employee_code", employeeCode)
    .maybeSingle();

  let employeeId = existingEmployee?.id as string | undefined;
  if (!employeeId) {
    const { data: insertedEmployee, error: employeeError } = await fx.supabase
      .from("employees")
      .insert({
        organization_id: fx.organizationId,
        first_name: firstName,
        last_name: "TestFixture",
        employee_code: employeeCode,
        default_station_id: null,
        auto_resolve_station: false,
        can_change_station: false,
        status: "active",
      })
      .select("id")
      .single();
    if (employeeError && employeeError.code !== "23505") throw employeeError;
    employeeId = insertedEmployee?.id as string | undefined;
    if (!employeeId) {
      const { data: refetched } = await fx.supabase
        .from("employees")
        .select("id")
        .eq("organization_id", fx.organizationId)
        .eq("employee_code", employeeCode)
        .single();
      employeeId = refetched!.id as string;
    }
  }

  const { data: existingAppUser } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();
  let appUserId = existingAppUser?.id as string | undefined;
  if (!appUserId) {
    const pinPepper = process.env.PIN_PEPPER;
    if (!pinPepper) throw new Error("PIN_PEPPER is not set");
    const pin = randomUUID().replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
    const { data: insertedAppUser, error: appUserError } = await fx.supabase
      .from("app_users")
      .insert({
        organization_id: fx.organizationId,
        employee_id: employeeId,
        pin_lookup_hash: hashPinLookup(pin, pinPepper),
        pin_hash: await hashPinForStorage(pin),
        is_active: true,
      })
      .select("id")
      .single();
    if (appUserError && appUserError.code !== "23505") throw appUserError;
    appUserId = insertedAppUser?.id as string | undefined;
    if (!appUserId) {
      const { data: refetched } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).single();
      appUserId = refetched!.id as string;
    }
  }

  const { data: managerRole, error: roleLookupError } = await fx.supabase.from("roles").select("id").eq("name", "manager").single();
  if (roleLookupError) throw roleLookupError;

  const { error: roleGrantError } = await fx.supabase
    .from("user_roles")
    .insert({ app_user_id: appUserId, role_id: managerRole!.id, organization_id: fx.organizationId });
  if (roleGrantError && roleGrantError.code !== "23505") throw roleGrantError;

  return appUserId;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
}, 60_000);

describe("record_inventory_waste -- standalone Inventory Waste", () => {
  it("1-2. manager records storage waste; exact location balance decreases correctly", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 20);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "3",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });

    expect(result.replayed).toBe(false);
    expect(result.quantity).toBe("3");
    expect(await balanceAt(item.inventoryItemId, location)).toBe(17);
  });

  it("3. sibling location untouched", async () => {
    const locationA = await createStorageLocation(fx.organizationId);
    const locationB = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 10);
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationB, 10);

    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: locationA,
      inventoryItemId: item.inventoryItemId,
      quantity: "4",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });

    expect(await balanceAt(item.inventoryItemId, locationA)).toBe(6);
    expect(await balanceAt(item.inventoryItemId, locationB)).toBe(10);
  });

  it("4. quantity > available rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 5);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "6",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InsufficientInventoryError);
    expect(await balanceAt(item.inventoryItemId, location)).toBe(5);
  });

  it("5. quantity = available succeeds to zero", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 5);

    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "5",
      reasonCode: "DAMAGED",
      note: null,
      clientRequestId: randomUUID(),
    });
    expect(await balanceAt(item.inventoryItemId, location)).toBe(0);
  });

  it("6. zero quantity rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 5);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "0",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteQuantityError);
  });

  it("7. negative quantity rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 5);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "-2",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteQuantityError);
  });

  it("8. base unit enforced -- the resulting movement line's unit is always the item's own base unit, never a client-supplied unit (no unit param exists at all)", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "2",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const { data: line } = await fx.supabase
      .from("inventory_movement_lines")
      .select("entered_unit_id, base_unit_id")
      .eq("id", result.movementLineId)
      .single();
    expect(line!.entered_unit_id).toBe(item.baseUnitId);
    expect(line!.base_unit_id).toBe(item.baseUnitId);
  });

  it("9. count-unit integer validation -- a whole-number quantity is accepted, a fractional one is rejected for a COUNT base unit", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "2.5",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteQuantityError);

    const ok = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "2",
      reasonCode: "DAMAGED",
      note: null,
      clientRequestId: randomUUID(),
    });
    expect(ok.quantity).toBe("2");
  });

  it("10. decimal weight/volume allowed appropriately", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "2.75",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });
    expect(result.quantity).toBe("2.75");
  });

  it("11. inactive item rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);
    await fx.supabase.from("inventory_items").update({ status: "inactive" }).eq("id", item.inventoryItemId);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "1",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteItemError);
  });

  it("12. inactive location rejected", async () => {
    const location = await createStorageLocation(fx.organizationId, { isActive: false });
    const item = await createTestItem("LB");

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "1",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidStorageLocationError);
  });

  it("13. non-storage location rejected", async () => {
    const location = await createStorageLocation(fx.organizationId, { isStorageEligible: false });
    const item = await createTestItem("LB");

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "1",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidStorageLocationError);
  });

  it("14. cross-org location rejected", async () => {
    const item = await createTestItem("LB");
    const otherOrgLocation = await createStorageLocation(otherOrg.organizationId);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: otherOrgLocation,
        inventoryItemId: item.inventoryItemId,
        quantity: "1",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidStorageLocationError);
  });

  it("15. cross-org item rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    // otherOrg has no inventory item fixture of its own -- a random uuid
    // is functionally identical to "an item that exists, but not in this
    // organization" from record_inventory_waste's point of view (its
    // active-item lookup is always organization-scoped).
    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: randomUUID(),
        quantity: "1",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteItemError);
  });

  it("16. reason required -- a raw call with no recognized reason_code is rejected", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const { error } = await fx.supabase.rpc("record_inventory_waste", {
      p_recorded_by_app_user_id: MANAGER_A(),
      p_location_id: location,
      p_inventory_item_id: item.inventoryItemId,
      p_quantity: "1",
      p_reason_code: "NOT_A_REAL_REASON",
      p_note: null,
      p_client_request_id: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("17. Other requires note", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "1",
        reasonCode: "OTHER",
        note: "   ",
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(WasteNoteRequiredError);
  });

  it("18. standard reason may omit note", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });
    expect(result.wasteEventId).toBeTruthy();
  });

  it("19. note trimmed", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "OTHER",
      note: "  Found during inspection.  ",
      clientRequestId: randomUUID(),
    });
    const { data } = await fx.supabase.from("inventory_waste_events").select("note").eq("id", result.wasteEventId).single();
    expect(data!.note).toBe("Found during inspection.");
  });

  it("20. waste business record linked to movement (strong 1:1 FK)", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });
    const { data } = await fx.supabase.from("inventory_waste_events").select("inventory_movement_id").eq("id", result.wasteEventId).single();
    expect(data!.inventory_movement_id).toBe(result.movementId);

    const { data: movement } = await fx.supabase.from("inventory_movements").select("movement_type, location_attribution").eq("id", result.movementId).single();
    expect(movement!.movement_type).toBe("WASTE");
    expect(movement!.location_attribution).toBe("EXACT");
  });

  it("21. audit event written", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });
    const { data } = await fx.supabase
      .from("audit_events")
      .select("action, entity_type, entity_id")
      .eq("entity_id", result.wasteEventId)
      .eq("action", "INVENTORY_WASTE_RECORDED")
      .maybeSingle();
    expect(data).not.toBeNull();
    expect(data!.entity_type).toBe("inventory_waste_event");
  });

  it("22. stock reference unchanged -- waste is not a restock (Part 16)", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 30);

    const { error: refError } = await fx.supabase.from("inventory_stock_references").insert({
      organization_id: fx.organizationId,
      inventory_item_id: item.inventoryItemId,
      location_id: location,
      full_quantity: 50,
      base_unit_id: item.baseUnitId,
      source: "MANAGER_OVERRIDE",
      set_by_app_user_id: MANAGER_A(),
    });
    if (refError) throw refError;

    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "5",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });

    expect(await balanceAt(item.inventoryItemId, location)).toBe(25);
    const { data: refs } = await fx.supabase
      .from("inventory_stock_references")
      .select("full_quantity")
      .eq("inventory_item_id", item.inventoryItemId)
      .eq("location_id", location)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(Number(refs![0].full_quantity)).toBe(50);
  });

  it("23. exact idempotent replay", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);
    const clientRequestId = randomUUID();

    const input = {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "3",
      reasonCode: "EXPIRED" as const,
      note: null,
      clientRequestId,
    };
    const first = await recordInventoryWaste(fx.supabase, input);
    expect(first.replayed).toBe(false);
    const second = await recordInventoryWaste(fx.supabase, input);
    expect(second.replayed).toBe(true);
    expect(second.wasteEventId).toBe(first.wasteEventId);
    expect(second.movementId).toBe(first.movementId);
    expect(await balanceAt(item.inventoryItemId, location)).toBe(7); // deducted exactly once
  });

  it("24. changed-payload request conflict", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);
    const clientRequestId = randomUUID();

    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "3",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId,
    });

    await expect(
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "4", // different payload, same request id
        reasonCode: "EXPIRED",
        note: null,
        clientRequestId,
      })
    ).rejects.toBeInstanceOf(WasteRequestConflictError);
  });

  it("25. concurrent duplicate request (same clientRequestId, identical payload) cannot double-deduct", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);
    const clientRequestId = randomUUID();

    const input = {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "3",
      reasonCode: "EXPIRED" as const,
      note: null,
      clientRequestId,
    };

    const [a, b] = await Promise.all([recordInventoryWaste(fx.supabase, input), recordInventoryWaste(fx.supabase, input)]);
    expect(a.wasteEventId).toBe(b.wasteEventId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await balanceAt(item.inventoryItemId, location)).toBe(7);
  });

  it("26. two concurrent independent wastes cannot oversubscribe stock", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 15);

    const attempt = () =>
      recordInventoryWaste(fx.supabase, {
        recordedByAppUserId: MANAGER_A(),
        locationId: location,
        inventoryItemId: item.inventoryItemId,
        quantity: "10",
        reasonCode: "DAMAGED",
        note: null,
        clientRequestId: randomUUID(),
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (failed[0].status === "rejected") {
      expect(failed[0].reason).toBeInstanceOf(InsufficientInventoryError);
    }
    expect(await balanceAt(item.inventoryItemId, location)).toBe(5); // 15 - 10, never negative
  });

  it("29-30. history returns correct org-only records, newest first", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const first = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const events = await listInventoryWasteEvents(fx.supabase, { organizationId: fx.organizationId, locationId: location });
    const ids = events.map((e) => e.wasteEventId);
    expect(ids.indexOf(second.wasteEventId)).toBeLessThan(ids.indexOf(first.wasteEventId)); // newest first
    expect(events.every((e) => e.locationId === location)).toBe(true);

    // Cross-org: an org-B caller never sees this org's events.
    const otherOrgEvents = await listInventoryWasteEvents(fx.supabase, { organizationId: otherOrg.organizationId });
    expect(otherOrgEvents.find((e) => e.wasteEventId === first.wasteEventId)).toBeUndefined();
  });

  it("31. detail read-only -- no UPDATE/DELETE is ever permitted on a posted waste event", async () => {
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);

    const result = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "1",
      reasonCode: "EXPIRED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const updateResult = await fx.supabase.from("inventory_waste_events").update({ quantity: 999 }).eq("id", result.wasteEventId);
    expect(updateResult.error).not.toBeNull();

    const deleteResult = await fx.supabase.from("inventory_waste_events").delete().eq("id", result.wasteEventId);
    expect(deleteResult.error).not.toBeNull();

    const detail = await getInventoryWasteDetail(fx.supabase, fx.organizationId, result.wasteEventId);
    expect(detail).not.toBeNull();
    expect(detail!.quantity).toBe("1");

    // Cross-org: a genuinely different organization's lookup returns
    // null (Part 17 -- "Cross-org access must fail"), never another
    // org's data.
    const crossOrgDetail = await getInventoryWasteDetail(fx.supabase, otherOrg.organizationId, result.wasteEventId);
    expect(crossOrgDetail).toBeNull();
  });
});

describe("record_inventory_waste -- manager/admin notification broadcast (20260811100088)", () => {
  it("notifies every active manager/admin in the org except the recorder, and only once per waste event", async () => {
    const recipientAppUserId = await ensureManagerRoleAppUser("TEST-RPC-WASTE-NOTIFY-MGR", "TestWasteNotifyManager");
    const location = await createStorageLocation(fx.organizationId);
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, location, 10);
    const clientRequestId = randomUUID();

    const input = {
      recordedByAppUserId: MANAGER_A(),
      locationId: location,
      inventoryItemId: item.inventoryItemId,
      quantity: "3",
      reasonCode: "SPOILED" as const,
      note: null,
      clientRequestId,
    };
    const result = await recordInventoryWaste(fx.supabase, input);

    const { data: notifications, error } = await fx.supabase
      .from("user_notifications")
      .select("recipient_app_user_id, type, entity_type, entity_id, title, body")
      .eq("entity_id", result.wasteEventId)
      .eq("type", "INVENTORY_WASTE_RECORDED");
    if (error) throw error;

    const forRecipient = notifications!.filter((n) => n.recipient_app_user_id === recipientAppUserId);
    expect(forRecipient).toHaveLength(1);
    expect(forRecipient[0].entity_type).toBe("inventory_waste_event");
    expect(forRecipient[0].title).toContain("Inventory waste recorded");
    expect(forRecipient[0].body).toContain("Spoiled");

    // The recording manager never gets notified about their own entry.
    expect(notifications!.some((n) => n.recipient_app_user_id === MANAGER_A())).toBe(false);

    // A replay (same clientRequestId, identical payload) must not send a
    // second round of notifications.
    await recordInventoryWaste(fx.supabase, input);
    const { count } = await fx.supabase
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_app_user_id", recipientAppUserId)
      .eq("entity_id", result.wasteEventId);
    expect(count).toBe(1);
  });
});
