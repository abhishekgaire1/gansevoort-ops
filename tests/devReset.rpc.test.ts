import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Milestone 2A.4: reset_dev_organization_operational_data
 * (20260811100065). The real Gansevoort reset is executed via
 * scripts/reset-gansevoort-dev-operational-data.ts -- these tests prove
 * the function's guardrails and its delete-operational/preserve-master
 * behavior against a DISPOSABLE sandbox org ("TEST Reset Sandbox ..."),
 * never against Gansevoort or the shared TEST fixture orgs.
 *
 * RUNS SERIALLY, AFTER the concurrent suite (see package.json's
 * test:integration): the reset function's ALTER TABLE ... DISABLE TRIGGER
 * USER takes ACCESS EXCLUSIVE locks, which can deadlock against other
 * test files' concurrent inventory/receipt transactions. That is inherent
 * to (and fine for) its real usage -- a maintenance script run on its own
 * -- so the test isolates the same way rather than weakening the reset.
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("reset guardrails", () => {
  it("refuses a wrong confirmation phrase", async () => {
    const { error } = await fx.supabase.rpc("reset_dev_organization_operational_data", {
      p_organization_id: fx.organizationId,
      p_confirmation: "yes please",
    });
    expect(error).not.toBeNull();
    // The org-name allow-list fires first for the fixture org -- either
    // guard refusing is correct; the essential fact is nothing ran.
    expect(error!.message).toMatch(/refusing|confirmation/i);
  });

  it("refuses to reset the shared TEST RPC Fixture Org even with a correct-shaped confirmation", async () => {
    const { error } = await fx.supabase.rpc("reset_dev_organization_operational_data", {
      p_organization_id: fx.organizationId,
      p_confirmation: "RESET TEST RPC FIXTURE ORG OPERATIONAL DATA",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/refusing to reset organization/i);
  });

  it("refuses an unknown organization id", async () => {
    const { error } = await fx.supabase.rpc("reset_dev_organization_operational_data", {
      p_organization_id: randomUUID(),
      p_confirmation: "RESET GANSEVOORT OPERATIONAL DATA",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not found/i);
  });
});

describe("reset behavior against a disposable sandbox org", () => {
  it("removes operational data, preserves master data, and leaves every other org untouched", async () => {
    const supabase = fx.supabase;
    const sandboxName = `TEST Reset Sandbox ${randomUUID().slice(0, 8)}`;

    // --- Build the sandbox: master data + minimal operational data. ---
    const { data: org, error: orgError } = await supabase.from("organizations").insert({ name: sandboxName }).select("id").single();
    if (orgError) throw orgError;
    const orgId = org!.id as string;

    const { data: loc } = await supabase
      .from("locations")
      .insert({ organization_id: orgId, name: "Sandbox Loc", timezone: "America/New_York" })
      .select("id")
      .single();
    const locId = loc!.id as string;

    const { data: employee } = await supabase
      .from("employees")
      .insert({ organization_id: orgId, first_name: "Sandbox", last_name: "Resetter", status: "active" })
      .select("id")
      .single();
    const { data: appUser } = await supabase
      .from("app_users")
      .insert({
        organization_id: orgId,
        employee_id: employee!.id as string,
        pin_lookup_hash: `sandbox-${randomUUID()}`,
        pin_hash: "sandbox-hash",
      })
      .select("id")
      .single();
    const appUserId = appUser!.id as string;

    const { data: category } = await supabase
      .from("inventory_categories")
      .insert({ organization_id: orgId, name: "Sandbox Category" })
      .select("id")
      .single();
    const { data: pieceUnit } = await supabase.from("units").select("id").eq("code", "PIECE").single();
    const { data: item } = await supabase
      .from("inventory_items")
      .insert({
        organization_id: orgId,
        category_id: category!.id as string,
        name: "Sandbox Confirmed Item",
        base_unit_id: pieceUnit!.id as string,
        status: "active",
        disposition: "INVENTORY",
        approval_status: "CONFIRMED",
        created_via: "MANUAL",
      })
      .select("id")
      .single();
    const itemId = item!.id as string;
    await supabase
      .from("inventory_item_units")
      .insert({ inventory_item_id: itemId, unit_id: pieceUnit!.id as string, conversion_factor: 1, is_default_entry_unit: true, is_active: true });

    // Operational rows: an inbound movement + line, a document, a rate-limit counter.
    const { data: movement, error: movementError } = await supabase
      .from("inventory_movements")
      .insert({
        organization_id: orgId,
        location_id: locId,
        movement_type: "PURCHASE_RECEIPT",
        performed_by_app_user_id: appUserId,
        business_date: "2026-08-18",
      })
      .select("id")
      .single();
    if (movementError) throw movementError;
    await supabase
      .from("inventory_movement_lines")
      .insert({ movement_id: movement!.id as string, inventory_item_id: itemId, entered_quantity: 5, entered_unit_id: pieceUnit!.id as string });

    await supabase.from("documents").insert({
      organization_id: orgId,
      uploaded_by_app_user_id: appUserId,
      storage_path: `org/${orgId}/documents/${randomUUID()}/original.pdf`,
      original_filename: "sandbox.pdf",
      content_type: "application/pdf",
      byte_size: 100,
      file_sha256: randomBytes(32).toString("hex"),
    });

    await supabase.from("pin_verify_rate_limits").insert({
      organization_id: orgId,
      rate_limit_key: "sandbox",
      window_start: new Date().toISOString(),
      attempt_count: 1,
    });

    // Fixture-org snapshot BEFORE (proves other orgs untouched).
    const { count: fixtureMovementsBefore } = await supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId);
    const { count: fixtureDocsBefore } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId);

    // --- Execute the reset. ---
    const { data: deleted, error: resetError } = await supabase.rpc("reset_dev_organization_operational_data", {
      p_organization_id: orgId,
      p_confirmation: `RESET ${sandboxName.toUpperCase()} OPERATIONAL DATA`,
    });
    expect(resetError).toBeNull();
    const counts = deleted as Record<string, number>;
    expect(counts.inventory_movements).toBe(1);
    expect(counts.inventory_movement_lines).toBe(1);
    expect(counts.documents).toBe(1);
    expect(counts.pin_verify_rate_limits).toBe(1);

    // Operational data gone.
    const { count: movementsAfter } = await supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
    expect(movementsAfter).toBe(0);
    const { count: docsAfter } = await supabase.from("documents").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
    expect(docsAfter).toBe(0);

    // Master data preserved.
    const { data: itemAfter } = await supabase.from("inventory_items").select("id, approval_status").eq("id", itemId).single();
    expect(itemAfter!.approval_status).toBe("CONFIRMED");
    const { count: locationsAfter } = await supabase.from("locations").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
    expect(locationsAfter).toBe(1);
    const { data: appUserAfter } = await supabase.from("app_users").select("id").eq("id", appUserId).single();
    expect(appUserAfter!.id).toBe(appUserId);

    // The append-only protection is back in force after the reset.
    const { error: deleteAfterReset } = await supabase.from("inventory_movements").delete().eq("organization_id", orgId);
    void deleteAfterReset; // zero rows match -- trigger simply has nothing to fire on
    const { data: probeMovement } = await supabase
      .from("inventory_movements")
      .insert({
        organization_id: orgId,
        location_id: locId,
        movement_type: "PURCHASE_RECEIPT",
        performed_by_app_user_id: appUserId,
        business_date: "2026-08-18",
      })
      .select("id")
      .single();
    const { error: forbidError } = await supabase.from("inventory_movements").delete().eq("id", probeMovement!.id as string);
    expect(forbidError).not.toBeNull();
    expect(forbidError!.message).toMatch(/append-only/i);

    // Other orgs untouched.
    const { count: fixtureMovementsAfter } = await supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId);
    const { count: fixtureDocsAfter } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId);
    // Concurrently-running test files may ADD fixture-org rows mid-test;
    // the reset can only ever DELETE, so >= proves it deleted nothing here.
    expect(fixtureMovementsAfter!).toBeGreaterThanOrEqual(fixtureMovementsBefore!);
    expect(fixtureDocsAfter!).toBeGreaterThanOrEqual(fixtureDocsBefore!);
  }, 30_000);
});
