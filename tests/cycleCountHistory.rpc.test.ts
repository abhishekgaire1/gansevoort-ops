import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startOrResumeCycleCount,
  addCycleCountLine,
  recordCycleCountLineObservation,
  completeCycleCount,
  cancelCycleCount,
  getCycleCountDetail,
  listCycleCountLines,
  listCycleCountSummaries,
} from "@/app/lib/inventory/cycleCounts";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { StaleCycleCountError, MissingCompletionNoteError } from "@/app/lib/inventory/errors";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for the shared rationale.
 *
 * Required completion notes (20260811100083_cycle_count_completion_note.sql)
 * and the Cycle Count hub's history summary query (list_cycle_count_
 * summaries). Fresh storage location + fresh item per test, same
 * cross-talk-avoidance rationale as cycleCounts.rpc.test.ts.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
const MANAGER_A = () => fx.changeableEmployeeAppUserId;
const MANAGER_B = () => fx.lockedEmployeeAppUserId;

async function createTestItem(baseUnitCode: "PIECE" | "LB"): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `CCH-${tag}`, description: `Cycle Count History Test Item ${tag}`, packageUnit: baseUnitCode, packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Cycle Count History Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode,
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

async function createStorageLocation(organizationId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { data, error } = await fx.supabase
    .from("locations")
    .insert({ organization_id: organizationId, name: `TEST History Location ${tag}`, timezone: "America/New_York", is_storage_eligible: true })
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

// Test-only, idempotent manager-role app_user -- mirrors the same
// find-or-insert-with-23505-fallback pattern testFixtures.ts's private
// ensureEmployeeAppUser uses, since that helper isn't exported and the
// shared TEST_ORG_NAME fixture persists across runs (never assume a
// clean slate; never insert a duplicate on rerun).
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

  await grantManagerRole(appUserId, fx.organizationId);
  return appUserId;
}

async function grantManagerRole(appUserId: string, organizationId: string): Promise<void> {
  const { data: managerRole, error: roleLookupError } = await fx.supabase.from("roles").select("id").eq("name", "manager").single();
  if (roleLookupError) throw roleLookupError;

  const { error: roleGrantError } = await fx.supabase
    .from("user_roles")
    .insert({ app_user_id: appUserId, role_id: managerRole!.id, organization_id: organizationId });
  if (roleGrantError && roleGrantError.code !== "23505") throw roleGrantError;
}

async function setUpCountedDraft(physicalQuantity: string): Promise<{ cycleCountId: string; version: number; locationId: string; itemId: string }> {
  const locationId = await createStorageLocation(fx.organizationId);
  const item = await createTestItem("PIECE");
  await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 10);
  const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
  await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: MANAGER_A() });
  await recordCycleCountLineObservation(fx.supabase, {
    cycleCountId: started.cycleCountId,
    inventoryItemId: item.inventoryItemId,
    physicalCountQuantity: physicalQuantity,
    actorAppUserId: MANAGER_A(),
  });
  return { cycleCountId: started.cycleCountId, version: started.version, locationId, itemId: item.inventoryItemId };
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
}, 60_000);

describe("complete_cycle_count -- required completion note", () => {
  it("1. rejects completion with no note at all", async () => {
    const draft = await setUpCountedDraft("7");
    await expect(
      completeCycleCount(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        expectedVersion: draft.version,
        completedByAppUserId: MANAGER_A(),
        completionNote: "",
      })
    ).rejects.toThrow(MissingCompletionNoteError);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status, completion_note").eq("id", draft.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
    expect(cc!.completion_note).toBeNull();
  });

  it("2. rejects a whitespace-only note", async () => {
    const draft = await setUpCountedDraft("7");
    await expect(
      completeCycleCount(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        expectedVersion: draft.version,
        completedByAppUserId: MANAGER_A(),
        completionNote: "   \n\t  ",
      })
    ).rejects.toThrow(MissingCompletionNoteError);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status").eq("id", draft.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
  });

  it("3-4. accepts a valid note, trimmed, stored atomically with completion", async () => {
    const draft = await setUpCountedDraft("7");
    const result = await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "  Weekly check. All items matched.  ",
    });
    expect(result.replayed).toBe(false);

    const { data: cc } = await fx.supabase
      .from("inventory_cycle_counts")
      .select("status, completion_note, completed_at, completed_by_app_user_id")
      .eq("id", draft.cycleCountId)
      .single();
    expect(cc!.status).toBe("COMPLETED");
    expect(cc!.completion_note).toBe("Weekly check. All items matched."); // trimmed
    expect(cc!.completed_at).not.toBeNull();
    expect(cc!.completed_by_app_user_id).toBe(MANAGER_A());
  });

  it("5-6. a stale completion attempt does not mark the count completed and creates no adjustments, even with a valid note", async () => {
    const draft = await setUpCountedDraft("7");
    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: MANAGER_A(),
      stationId: fx.stationId,
      inventoryItemId: draft.itemId,
      sourceLocationId: draft.locationId,
      enteredQuantity: "1",
      enteredUnitId: (await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", draft.itemId).single()).data!
        .base_unit_id as string,
      clientRequestId: randomUUID(),
    });

    await expect(
      completeCycleCount(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        expectedVersion: draft.version,
        completedByAppUserId: MANAGER_A(),
        completionNote: "A perfectly valid note that must NOT be saved.",
      })
    ).rejects.toThrow(StaleCycleCountError);

    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status, completion_note").eq("id", draft.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT"); // never completed
    expect(cc!.completion_note).toBeNull(); // note was never persisted
    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId);
    expect(movementCount).toBe(0); // no adjustments either
  });

  it("7. a completed count's note is immutable -- direct update rejected, replay never overwrites it", async () => {
    const draft = await setUpCountedDraft("7");
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Original note.",
    });

    const { error } = await fx.supabase.from("inventory_cycle_counts").update({ completion_note: "hacked" }).eq("id", draft.cycleCountId);
    expect(error).not.toBeNull(); // forbid_locked_mutation trigger rejects it

    // Replaying completion (even with a different note argument) never
    // re-validates or overwrites what's already stored.
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "A different note on replay.",
    });
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("completion_note").eq("id", draft.cycleCountId).single();
    expect(cc!.completion_note).toBe("Original note.");
  });

  it("7b. a direct/raw UPDATE bypassing complete_cycle_count entirely is rejected by the DATABASE trigger, not just the RPC", async () => {
    // Proves the enforcement boundary is inventory_cycle_counts_forbid_
    // locked_mutation() itself (20260811100083), not merely complete_
    // cycle_count's own application-level check -- a caller with direct
    // table access (any role; the trigger fires for service_role too) who
    // tries to skip the RPC and hand-write status = 'COMPLETED' must still
    // be rejected for a missing or blank note.
    const draft = await setUpCountedDraft("7");

    const noNote = await fx.supabase
      .from("inventory_cycle_counts")
      .update({ status: "COMPLETED", completed_by_app_user_id: MANAGER_A(), completed_at: new Date().toISOString(), completion_note: null })
      .eq("id", draft.cycleCountId);
    expect(noNote.error).not.toBeNull();

    const blankNote = await fx.supabase
      .from("inventory_cycle_counts")
      .update({ status: "COMPLETED", completed_by_app_user_id: MANAGER_A(), completed_at: new Date().toISOString(), completion_note: "   " })
      .eq("id", draft.cycleCountId);
    expect(blankNote.error).not.toBeNull();

    // The count is still an untouched DRAFT -- neither rejected attempt
    // left any partial state behind.
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status, completion_note").eq("id", draft.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
    expect(cc!.completion_note).toBeNull();

    // A raw UPDATE that DOES supply a valid note is accepted by the
    // trigger (it only guards the invariant, it doesn't force callers
    // through the RPC) -- confirms the trigger validates content, not
    // merely "was this the RPC."
    const validNote = await fx.supabase
      .from("inventory_cycle_counts")
      .update({ status: "COMPLETED", completed_by_app_user_id: MANAGER_A(), completed_at: new Date().toISOString(), completion_note: "Raw completion." })
      .eq("id", draft.cycleCountId);
    expect(validNote.error).toBeNull();
  });

  it("1b. a historical COMPLETED count with a null completion_note (predating this feature) remains valid, readable history, never rejected on read", async () => {
    // A genuinely pre-migration row (COMPLETED, completion_note = NULL)
    // cannot be fabricated inside this fixture-based suite: the fixture
    // organization is created fresh per run, so every row in it is
    // necessarily written AFTER the trigger extension exists, and the
    // trigger correctly refuses to let any NEW write land in that state
    // (proven by 7b above). That refusal is exactly the point -- grand-
    // fathering is a property of migration 20260811100083 doing a plain
    // `alter table ... add column` (metadata-only, touches zero existing
    // rows) and NOT adding any CHECK constraint on completion_note, so
    // whatever historical rows already exist in DEV are simply never
    // re-validated. What CAN be verified here at runtime is the other
    // half of that guarantee: the read paths (list_cycle_count_summaries,
    // get_cycle_count_detail) never filter on, coerce, or error over a
    // null completion_note for a terminal-status row -- proven with a
    // CANCELLED count, whose completion_note is null through the exact
    // same unconditional column read the SQL uses for COMPLETED rows.
    const draft = await setUpCountedDraft("7");
    await cancelCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      cancelledByAppUserId: MANAGER_A(),
      reason: "Verifying null completion_note round-trips cleanly on read.",
    });

    const summaries = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["CANCELLED"],
      locationId: draft.locationId,
    });
    const summary = summaries.find((s) => s.cycleCountId === draft.cycleCountId);
    expect(summary).toBeDefined();
    expect(summary!.completionNote).toBeNull();

    const detail = await getCycleCountDetail(fx.supabase, fx.organizationId, draft.cycleCountId, MANAGER_A());
    expect(detail).not.toBeNull();
    expect(detail!.completionNote).toBeNull();
    expect(detail!.status).toBe("CANCELLED");
  });

  it("22. historical detail is read-only -- no further mutation is possible once COMPLETED, by the owner or otherwise", async () => {
    const draft = await setUpCountedDraft("7");
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Done.",
    });

    await expect(
      recordCycleCountLineObservation(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        physicalCountQuantity: "99",
        actorAppUserId: MANAGER_A(),
      })
    ).rejects.toThrow(/not open for counting/);

    // Lines ARE still readable (Part "HISTORY ACCESS"), just never
    // writable -- listCycleCountLines has no ownership gate of its own
    // (that lives at the Server Action layer); confirm the read itself
    // still works and reflects the immutable completed state.
    const lines = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    expect(lines.find((l) => l.inventoryItemId === draft.itemId)?.physicalCountQuantity).toBe("7");
  });
});

describe("complete_cycle_count -- manager/admin notification broadcast (20260811100084)", () => {
  it("notifies every active manager/admin in the org except the completer, and only once per completion", async () => {
    const recipientAppUserId = await ensureManagerRoleAppUser("TEST-RPC-NOTIFY-MGR", "TestNotifyManager");
    const draft = await setUpCountedDraft("7"); // expected 10, physical 7 -> 1 variance

    const before = await fx.supabase
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_app_user_id", recipientAppUserId)
      .eq("entity_id", draft.cycleCountId);
    expect(before.count).toBe(0);

    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Notification broadcast test.",
    });

    const { data: notifications, error } = await fx.supabase
      .from("user_notifications")
      .select("recipient_app_user_id, type, entity_type, entity_id, title, body")
      .eq("entity_id", draft.cycleCountId)
      .eq("type", "CYCLE_COUNT_COMPLETED");
    if (error) throw error;

    const forRecipient = notifications!.filter((n) => n.recipient_app_user_id === recipientAppUserId);
    expect(forRecipient).toHaveLength(1);
    expect(forRecipient[0].entity_type).toBe("inventory_cycle_count");
    expect(forRecipient[0].title).toContain("Cycle count completed");
    expect(forRecipient[0].body).toContain("1 variance");

    // The completing manager never gets a notification about their own
    // completion, and a plain employee with no manager/admin role (MANAGER_B
    // is a bare test employee, no user_roles row) never gets one either.
    expect(notifications!.some((n) => n.recipient_app_user_id === MANAGER_A())).toBe(false);
    expect(notifications!.some((n) => n.recipient_app_user_id === MANAGER_B())).toBe(false);

    // Replaying the same completion (idempotent replay, Part 18) must not
    // send a second round of notifications.
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Notification broadcast test.",
    });
    const after = await fx.supabase
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_app_user_id", recipientAppUserId)
      .eq("entity_id", draft.cycleCountId);
    expect(after.count).toBe(1);
  });

  it("never notifies a manager/admin from a different organization", async () => {
    // Grant the OTHER org's fixture app_user the manager role too -- this
    // proves the notification insert is genuinely org-scoped (v_org_id,
    // derived server-side from the completing manager), not merely role-
    // scoped: without this grant, the assertion below would pass trivially
    // even if org-scoping were broken, since otherOrg.appUserId would fail
    // the role filter regardless.
    await grantManagerRole(otherOrg.appUserId, otherOrg.organizationId);

    const draft = await setUpCountedDraft("10"); // expected 10, physical 10 -> no variance
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Cross-org isolation test.",
    });

    const { data: notifications, error } = await fx.supabase
      .from("user_notifications")
      .select("recipient_app_user_id, organization_id")
      .eq("entity_id", draft.cycleCountId)
      .eq("type", "CYCLE_COUNT_COMPLETED");
    if (error) throw error;

    expect(notifications!.some((n) => n.recipient_app_user_id === otherOrg.appUserId)).toBe(false);
    expect(notifications!.every((n) => n.organization_id === fx.organizationId)).toBe(true);
  });
});

describe("cancel_cycle_count -- unaffected by the completion-note requirement", () => {
  it("23. cancellation still creates no inventory adjustments and needs no completion note", async () => {
    const draft = await setUpCountedDraft("7");
    const cancelled = await cancelCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      cancelledByAppUserId: MANAGER_A(),
      reason: "Testing that cancellation is unaffected by completion notes.",
    });
    expect(cancelled.status).toBe("CANCELLED");
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("completion_note").eq("id", draft.cycleCountId).single();
    expect(cc!.completion_note).toBeNull();
    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId);
    expect(movementCount).toBe(0);
  });
});

describe("list_cycle_count_summaries -- history", () => {
  it("8-11, 13-15. lists a completed count with starter, completer, counted/variance counts", async () => {
    const draft = await setUpCountedDraft("7"); // expected 10, physical 7 -> variance
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "History summary test.",
    });

    const summaries = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["COMPLETED"],
      locationId: draft.locationId,
    });
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.status).toBe("COMPLETED");
    expect(summary.startedByAppUserId).toBe(MANAGER_A());
    expect(summary.startedByName.length).toBeGreaterThan(0);
    expect(summary.completedByAppUserId).toBe(MANAGER_A());
    expect(summary.completedByName).not.toBeNull();
    expect(summary.completedByName!.length).toBeGreaterThan(0);
    expect(summary.completionNote).toBe("History summary test.");
    expect(summary.countedItemCount).toBe(1); // test 13
    expect(summary.varianceItemCount).toBe(1); // test 14 -- 7 != 10
  });

  it("9, 12. lists a cancelled count with the cancellation actor", async () => {
    const draft = await setUpCountedDraft("7");
    await cancelCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      cancelledByAppUserId: MANAGER_A(),
      reason: "History summary cancellation test.",
    });

    const summaries = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["CANCELLED"],
      locationId: draft.locationId,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe("CANCELLED");
    expect(summaries[0].cancelledByAppUserId).toBe(MANAGER_A());
    expect(summaries[0].cancelledByName).not.toBeNull();
    expect(summaries[0].cancelledByName!.length).toBeGreaterThan(0);
    expect(summaries[0].cancellationReason).toBe("History summary cancellation test.");
  });

  it("15. a zero-variance completed count reports varianceItemCount 0 internally", async () => {
    const draft = await setUpCountedDraft("10"); // expected 10, physical 10 -> no variance
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "All matched.",
    });

    const summaries = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["COMPLETED"],
      locationId: draft.locationId,
    });
    expect(summaries[0].countedItemCount).toBe(1);
    expect(summaries[0].varianceItemCount).toBe(0);
  });

  it("16-17. DRAFT is excluded from the default history query, but shown when statuses explicitly includes it", async () => {
    const draft = await setUpCountedDraft("7"); // never completed or cancelled -- stays DRAFT

    const history = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      locationId: draft.locationId,
      // default statuses: COMPLETED + CANCELLED
    });
    expect(history).toHaveLength(0);

    const inProgress = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["DRAFT"],
      locationId: draft.locationId,
    });
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].cycleCountId).toBe(draft.cycleCountId);
  });

  it("18-19. isOwnedByCurrentManager (and therefore resumability) reflects the ACTUAL caller, not the starter", async () => {
    const draft = await setUpCountedDraft("7");

    const asOwner = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_A(),
      statuses: ["DRAFT"],
      locationId: draft.locationId,
    });
    expect(asOwner[0].isOwnedByCurrentManager).toBe(true);

    const asOther = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId,
      currentActorAppUserId: MANAGER_B(),
      statuses: ["DRAFT"],
      locationId: draft.locationId,
    });
    expect(asOther[0].isOwnedByCurrentManager).toBe(false);
  });

  it("20. a same-org manager can view another manager's historical (COMPLETED) count", async () => {
    const draft = await setUpCountedDraft("7");
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Viewable by anyone in the org.",
    });

    // getCycleCountDetail as a DIFFERENT manager in the same org.
    const detailAsOther = await getCycleCountDetail(fx.supabase, fx.organizationId, draft.cycleCountId, MANAGER_B());
    expect(detailAsOther).not.toBeNull();
    expect(detailAsOther!.status).toBe("COMPLETED");
    expect(detailAsOther!.completionNote).toBe("Viewable by anyone in the org.");
    expect(detailAsOther!.isOwnedByCurrentManager).toBe(false); // still correctly not "theirs" -- but still visible

    const linesAsOther = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    expect(linesAsOther.find((l) => l.inventoryItemId === draft.itemId)).toBeDefined();
  });

  it("21. cross-org: a count from another organization never appears in this org's history, and its detail lookup returns null", async () => {
    const otherOrgLocationId = await createStorageLocation(otherOrg.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId: otherOrgLocationId, startedByAppUserId: otherOrg.appUserId });
    await cancelCycleCount(fx.supabase, {
      cycleCountId: started.cycleCountId,
      expectedVersion: started.version,
      cancelledByAppUserId: otherOrg.appUserId,
      reason: "Other org cancellation.",
    });

    const crossOrgSummaries = await listCycleCountSummaries(fx.supabase, {
      organizationId: fx.organizationId, // OUR org, not otherOrg's
      currentActorAppUserId: MANAGER_A(),
      statuses: ["CANCELLED"],
      locationId: otherOrgLocationId,
    });
    expect(crossOrgSummaries).toHaveLength(0);

    const crossOrgDetail = await getCycleCountDetail(fx.supabase, fx.organizationId, started.cycleCountId, MANAGER_A());
    expect(crossOrgDetail).toBeNull();
  });
});
