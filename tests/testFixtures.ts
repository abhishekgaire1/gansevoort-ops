import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { normalizeVendorName } from "@/app/lib/vendors/normalizeVendorName";
import { resolveCanonicalOrgId, ensureCanonicalOrgId } from "@/scripts/lib/canonicalOrg";

/**
 * Shared fixture setup for the manual/on-demand integration tests
 * (pin.integration.test.ts, withdrawal.rpc.test.ts, and every .rpc.test.ts
 * file). These tests touch the linked Supabase dev database directly and
 * are NOT run in CI (project testing policy: only pure/local deterministic
 * tests run automatically).
 *
 * ORGANIZATION ISOLATION: every fixture created here lives inside the
 * dedicated TEST_ORG_NAME organization (see resolveTestOrgId below), never
 * the real "Gansevoort" organization a manager uses for manual browser
 * testing. This was NOT always true -- an earlier version of this file
 * looked up "Gansevoort" directly and seeded stations/employees/vendors/
 * documents/inventory_movements straight into it, which is exactly how
 * synthetic rows like "filler-199.pdf" and "TestChangeable TestFixture"
 * ended up visible on a real manager's /manager/receiving. Cross-org
 * isolation tests use a second, separate organization (see
 * setupOtherOrgFixtures/TEST RPC Fixture Org B below) -- never Gansevoort
 * either.
 *
 * resolveTestOrgId only ever RESOLVES the canonical test organization, it
 * never creates one -- creation is scripts/test-integration-setup.ts's job
 * alone, run once, serially, before Vitest's concurrent test files start
 * (see that script and scripts/lib/canonicalOrg.ts for why a fixed-name
 * organization can't safely be find-or-inserted from inside a race-prone
 * beforeAll).
 *
 * Most fixtures (stations, categories, inventory items, employees) are
 * found-or-created by a FIXED name (idempotent, same pattern as
 * scripts/dev-seed.ts) so repeated manual runs reuse the same master-data
 * rows rather than accumulating new ones -- only the movements/exceptions/
 * audit_events actually produced by a test run accumulate, which is
 * unavoidable: those tables are append-only even for service_role. This has
 * been safe in practice because those rows have existed in the linked DEV
 * database (inside the test organization) since the first run after this
 * fixture existed -- by now, every "find" half of find-or-insert reliably
 * finds an existing row rather than racing another insert.
 *
 * Vendors are different: vendors_org_normalized_name_key (organization_id,
 * normalized_name) is a real, intentional production constraint (never
 * weakened for tests), and multiple .rpc.test.ts files call
 * setupRpcTestFixtures() independently, each in its own beforeAll. Vitest
 * runs separate test files concurrently by default, so when a fixed vendor
 * name is genuinely new, multiple files' "not found, so insert" halves can
 * race each other and lose to the same unique constraint that's protecting
 * real data. Fixed-name find-or-insert only avoids this once some run has
 * already won the race and created the row -- the very first time (or any
 * time against a database that doesn't already have it) it's a real
 * collision, not a flake. The fix here is not more locking/retrying --
 * it's giving every fixture-creating call its own name in the first place,
 * via createTestVendor's per-call runId, so there is never a shared row to
 * race over. Tests that deliberately exercise normalized-duplicate-vendor
 * rejection (see app/actions/vendors.ts's createVendor 23505 handling) are
 * unaffected -- those tests insert the SAME name twice on purpose, within
 * a single mocked unit test, never through this shared fixture path.
 */

const TEST_PREFIX = "TEST RPC Fixture ";

/** Deterministic within one setupRpcTestFixtures()/setupOtherOrgFixtures()
 * call (every vendor created by that call shares it), unique across
 * separate calls/files/runs. */
function generateRunId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Always a fresh INSERT, never found-or-reused -- safe specifically because
 * the caller-supplied runId makes the name (and therefore
 * normalized_name) unique per call, so there is no existing row to race
 * against and no ambiguity about which row "the" fixture vendor is. Do NOT
 * use this for a test that deliberately wants two vendors to collide on the
 * same normalized name -- construct that name directly in the test instead.
 */
export async function createTestVendor(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { namePrefix: string; runId: string; isActive?: boolean }
): Promise<string> {
  const name = `${opts.namePrefix} ${opts.runId}`;
  const { data, error } = await supabase
    .from("vendors")
    .insert({
      organization_id: organizationId,
      name,
      normalized_name: normalizeVendorName(name),
      is_active: opts.isActive ?? true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export interface RpcTestFixtures {
  supabase: SupabaseClient;
  organizationId: string;
  stationId: string;
  otherStationId: string;
  variableWeightItemId: string;
  variableWeightBoxUnitId: string;
  /** variableWeightItemId's own base unit (LB), also configured as a
   * self-referencing inventory_item_units row (conversion_factor 1) --
   * see the withdrawal-unit-simplification migration
   * 20260811100016_enforce_withdrawal_base_unit.sql. This is the only
   * unit an ISSUE_TO_STATION withdrawal may legally use for this item;
   * variableWeightBoxUnitId (a packaging unit, kept for future receiving)
   * must now be rejected. */
  variableWeightLbUnitId: string;
  fixedConversionItemId: string;
  fixedConversionCaseUnitId: string;
  /** fixedConversionItemId's own base unit (PIECE), also configured as a
   * self-referencing inventory_item_units row -- same role as
   * variableWeightLbUnitId above, but for a fixed-conversion-style
   * packaging unit (CASE) rather than a measurement-required one (BOX),
   * so both packaging-unit shapes are covered by the rejection tests. */
  fixedConversionPieceUnitId: string;
  noRuleItemId: string;
  noRuleUnitId: string;
  /** A VOLUME-tracked item whose base unit (GAL) is its only configured
   * entry unit -- covers the third tracking basis for base-unit
   * withdrawal tests. */
  volumeItemId: string;
  volumeUnitId: string;
  wrongUnitId: string;
  lockedEmployeeAppUserId: string;
  lockedEmployeePin: string;
  changeableEmployeeAppUserId: string;
  changeableEmployeePin: string;
  inactiveEmployeeAppUserId: string;
  /** auto_resolve_station=false -- the "must_pick" kiosk station branch
   * (see app/kiosk/_lib/stationBranch.ts), not covered by lockedEmployee
   * (branch 1) or changeableEmployee (branch 2). */
  mustPickEmployeeAppUserId: string;
  mustPickEmployeePin: string;
  /** Milestone 2A.2: an ACTIVE vendor, for finalize_document_upload /
   * initialize_purchase_document_draft-style tests. */
  vendorId: string;
  /** A DEACTIVATED vendor, for GA005 "vendor not active" rejection tests. */
  inactiveVendorId: string;
}

async function findOrInsert(
  supabase: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  insertRow: Record<string, unknown>
): Promise<string> {
  const existing = await findExisting(supabase, table, match);
  if (existing) return existing;

  const { data: inserted, error } = await supabase.from(table).insert(insertRow).select("id").single();
  if (!error) return inserted.id as string;

  if (error.code === "23505") {
    // Lost a race against a concurrently-running .rpc.test.ts file/worker
    // doing this exact same find-or-insert against a row that, unlike
    // vendors, was genuinely new to this run (every fixture under a
    // brand-new TEST RPC Fixture Org is "new" the first time any suite
    // runs against it, not just vendors) -- the row now exists because the
    // other caller won, so re-select it instead of treating this as a
    // real failure.
    const id = await findExisting(supabase, table, match);
    if (id) return id;
  }
  throw error;
}

async function findExisting(supabase: SupabaseClient, table: string, match: Record<string, unknown>): Promise<string | null> {
  let query = supabase.from(table).select("id");
  for (const [key, value] of Object.entries(match)) {
    query = query.eq(key, value);
  }
  const { data } = await query.maybeSingle();
  return (data?.id as string) ?? null;
}

/** The name (never "Gansevoort") that isolates every automated
 * integration-test fixture from the real DEV organization a manager uses
 * for manual browser testing -- see the module comment above. */
export const TEST_ORG_NAME = "TEST RPC Fixture Org";

/**
 * Read-only resolution of the canonical automated-test organization (see
 * scripts/lib/canonicalOrg.ts for what "canonical" means and why) plus its
 * required location -- this function NEVER creates either one. Creation is
 * the exclusive job of scripts/test-integration-setup.ts, which runs once,
 * serially, before Vitest's concurrent test files start (wired into `npm
 * run test:integration`). If that setup hasn't run, this fails with a
 * clear, actionable error rather than silently creating its own
 * organization/location the way earlier versions of this file did (which
 * is exactly how the org-fragmentation bug happened in the first place).
 */
export async function resolveTestOrgId(supabase: SupabaseClient): Promise<{ organizationId: string; locationId: string }> {
  const organizationId = await resolveCanonicalOrgId(supabase, TEST_ORG_NAME);
  if (!organizationId) {
    throw new Error(
      `No "${TEST_ORG_NAME}" organization found. Run \`npx tsx scripts/test-integration-setup.ts\` before running ` +
        `integration tests directly -- \`npm run test:integration\` already does this for you.`
    );
  }

  const { data: location, error } = await supabase
    .from("locations")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!location) {
    throw new Error(
      `Organization "${TEST_ORG_NAME}" (${organizationId}) has no location yet. ` +
        "Run `npx tsx scripts/test-integration-setup.ts` before running integration tests directly."
    );
  }

  return { organizationId, locationId: location.id as string };
}

export async function setupRpcTestFixtures(): Promise<RpcTestFixtures> {
  const supabase = getServiceRoleClient();
  const { organizationId, locationId } = await resolveTestOrgId(supabase);

  const stationId = await findOrInsert(
    supabase,
    "stations",
    { organization_id: organizationId, name: `${TEST_PREFIX}Station A` },
    { organization_id: organizationId, location_id: locationId, name: `${TEST_PREFIX}Station A` }
  );
  const otherStationId = await findOrInsert(
    supabase,
    "stations",
    { organization_id: organizationId, name: `${TEST_PREFIX}Station B` },
    { organization_id: organizationId, location_id: locationId, name: `${TEST_PREFIX}Station B` }
  );

  const categoryId = await findOrInsert(
    supabase,
    "inventory_categories",
    { organization_id: organizationId, name: `${TEST_PREFIX}Category` },
    { organization_id: organizationId, name: `${TEST_PREFIX}Category` }
  );

  const { data: units } = await supabase.from("units").select("id, code");
  const unitIdByCode = new Map((units ?? []).map((u) => [u.code as string, u.id as string]));
  const lbUnitId = unitIdByCode.get("LB")!;
  const boxUnitId = unitIdByCode.get("BOX")!;
  const caseUnitId = unitIdByCode.get("CASE")!;
  const pieceUnitId = unitIdByCode.get("PIECE")!;
  const galUnitId = unitIdByCode.get("GAL")!;

  const variableWeightItemId = await findOrInsert(
    supabase,
    "inventory_items",
    { organization_id: organizationId, name: `${TEST_PREFIX}Variable Weight Item` },
    { organization_id: organizationId, category_id: categoryId, base_unit_id: lbUnitId, name: `${TEST_PREFIX}Variable Weight Item` }
  );
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: variableWeightItemId, unit_id: boxUnitId },
    { inventory_item_id: variableWeightItemId, unit_id: boxUnitId, requires_actual_measurement: true, is_default_entry_unit: true }
  );
  // Self-referencing base-unit row: the only unit an ISSUE_TO_STATION
  // withdrawal may use for this item under the withdrawal-unit
  // simplification -- BOX above stays purely for a future receiving flow.
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: variableWeightItemId, unit_id: lbUnitId },
    { inventory_item_id: variableWeightItemId, unit_id: lbUnitId, conversion_factor: 1, is_default_entry_unit: false }
  );

  const fixedConversionItemId = await findOrInsert(
    supabase,
    "inventory_items",
    { organization_id: organizationId, name: `${TEST_PREFIX}Fixed Conversion Item` },
    { organization_id: organizationId, category_id: categoryId, base_unit_id: pieceUnitId, name: `${TEST_PREFIX}Fixed Conversion Item` }
  );
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: fixedConversionItemId, unit_id: caseUnitId },
    { inventory_item_id: fixedConversionItemId, unit_id: caseUnitId, conversion_factor: 10, is_default_entry_unit: true }
  );
  // Self-referencing base-unit row -- same role as variableWeightLbUnitId
  // above, but for a fixed-conversion-style packaging unit (CASE).
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: fixedConversionItemId, unit_id: pieceUnitId },
    { inventory_item_id: fixedConversionItemId, unit_id: pieceUnitId, conversion_factor: 1, is_default_entry_unit: false }
  );

  const noRuleItemId = await findOrInsert(
    supabase,
    "inventory_items",
    { organization_id: organizationId, name: `${TEST_PREFIX}No Rule Item` },
    { organization_id: organizationId, category_id: categoryId, base_unit_id: pieceUnitId, name: `${TEST_PREFIX}No Rule Item` }
  );
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: noRuleItemId, unit_id: pieceUnitId },
    { inventory_item_id: noRuleItemId, unit_id: pieceUnitId, conversion_factor: 1, is_default_entry_unit: true }
  );

  const volumeItemId = await findOrInsert(
    supabase,
    "inventory_items",
    { organization_id: organizationId, name: `${TEST_PREFIX}Volume Item` },
    { organization_id: organizationId, category_id: categoryId, base_unit_id: galUnitId, name: `${TEST_PREFIX}Volume Item` }
  );
  await findOrInsert(
    supabase,
    "inventory_item_units",
    { inventory_item_id: volumeItemId, unit_id: galUnitId },
    { inventory_item_id: volumeItemId, unit_id: galUnitId, conversion_factor: 1, is_default_entry_unit: true }
  );

  // Low threshold so an over-threshold test withdrawal reliably trips it.
  await findOrInsert(
    supabase,
    "control_rules",
    { organization_id: organizationId, inventory_item_id: variableWeightItemId, station_id: stationId },
    {
      organization_id: organizationId,
      rule_type: "HIGH_WITHDRAWAL",
      inventory_item_id: variableWeightItemId,
      station_id: stationId,
      threshold_quantity: 10,
    }
  );

  const pinPepperEnv = process.env.PIN_PEPPER;
  if (!pinPepperEnv) throw new Error("PIN_PEPPER is not set");
  const pinPepper: string = pinPepperEnv;

  async function ensureEmployeeAppUser(
    employeeCode: string,
    firstName: string,
    pin: string,
    opts: { defaultStationId: string | null; autoResolveStation: boolean; canChangeStation: boolean; isActive: boolean }
  ): Promise<string> {
    const employeeId = await findOrInsert(
      supabase,
      "employees",
      { organization_id: organizationId, employee_code: employeeCode },
      {
        organization_id: organizationId,
        first_name: firstName,
        last_name: "TestFixture",
        employee_code: employeeCode,
        default_station_id: opts.defaultStationId,
        auto_resolve_station: opts.autoResolveStation,
        can_change_station: opts.canChangeStation,
        status: opts.isActive ? "active" : "inactive",
      }
    );

    const existingAppUser = await findExisting(supabase, "app_users", { employee_id: employeeId });
    if (existingAppUser) return existingAppUser;

    const { data: inserted, error } = await supabase
      .from("app_users")
      .insert({
        organization_id: organizationId,
        employee_id: employeeId,
        pin_lookup_hash: hashPinLookup(pin, pinPepper),
        pin_hash: await hashPinForStorage(pin),
        is_active: opts.isActive,
      })
      .select("id")
      .single();
    if (!error) return inserted.id as string;

    if (error.code === "23505") {
      const id = await findExisting(supabase, "app_users", { employee_id: employeeId });
      if (id) return id;
    }
    throw error;
  }

  const lockedEmployeePin = "1111";
  const lockedEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-LOCKED", "TestLocked", lockedEmployeePin, {
    defaultStationId: stationId,
    autoResolveStation: true,
    canChangeStation: false,
    isActive: true,
  });

  const changeableEmployeePin = "2222";
  const changeableEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-CHANGEABLE", "TestChangeable", changeableEmployeePin, {
    defaultStationId: stationId,
    autoResolveStation: true,
    canChangeStation: true,
    isActive: true,
  });

  const inactiveEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-INACTIVE", "TestInactive", "3333", {
    defaultStationId: null,
    autoResolveStation: false,
    canChangeStation: false,
    isActive: false,
  });

  const mustPickEmployeePin = "4444";
  const mustPickEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-MUST-PICK", "TestMustPick", mustPickEmployeePin, {
    defaultStationId: null,
    autoResolveStation: false,
    canChangeStation: false,
    isActive: true,
  });

  // Run-unique (see the module comment above) -- every call to
  // setupRpcTestFixtures gets its own vendor and inactive-vendor rows,
  // sharing one runId so both are recognizably part of the same suite
  // execution without colliding with any other file's or run's fixtures.
  const vendorRunId = generateRunId();
  const vendorId = await createTestVendor(supabase, organizationId, { namePrefix: `${TEST_PREFIX}Vendor`, runId: vendorRunId });
  const inactiveVendorId = await createTestVendor(supabase, organizationId, {
    namePrefix: `${TEST_PREFIX}Inactive Vendor`,
    runId: vendorRunId,
    isActive: false,
  });

  return {
    supabase,
    organizationId,
    stationId,
    otherStationId,
    variableWeightItemId,
    variableWeightBoxUnitId: boxUnitId,
    variableWeightLbUnitId: lbUnitId,
    fixedConversionItemId,
    fixedConversionCaseUnitId: caseUnitId,
    fixedConversionPieceUnitId: pieceUnitId,
    noRuleItemId,
    noRuleUnitId: pieceUnitId,
    volumeItemId,
    volumeUnitId: galUnitId,
    wrongUnitId: galUnitId,
    lockedEmployeeAppUserId,
    lockedEmployeePin,
    changeableEmployeeAppUserId,
    changeableEmployeePin,
    inactiveEmployeeAppUserId,
    mustPickEmployeeAppUserId,
    mustPickEmployeePin,
    vendorId,
    inactiveVendorId,
  };
}

export interface OtherOrgFixtures {
  organizationId: string;
  vendorId: string;
  appUserId: string;
}

/**
 * A second, entirely separate organization -- for cross-org isolation tests
 * (e.g. duplicate detection must never surface a match belonging to a
 * different organization) where a real row in a real different org is the
 * only genuine proof; a mocked-client unit test can only show the query
 * *would* filter by organization_id, not that Postgres actually enforces
 * it. Idempotent like the rest of this file's fixtures. Minimal on purpose:
 * just enough (one vendor, one app_user) to finalize a document and create
 * a purchase_document in this other org.
 */
export async function setupOtherOrgFixtures(supabase: SupabaseClient): Promise<OtherOrgFixtures> {
  const organizationId = await ensureCanonicalOrgId(supabase, `${TEST_PREFIX}Org B`);

  const employeeId = await findOrInsert(
    supabase,
    "employees",
    { organization_id: organizationId, employee_code: "TEST-RPC-ORGB" },
    {
      organization_id: organizationId,
      first_name: "TestOrgB",
      last_name: "TestFixture",
      employee_code: "TEST-RPC-ORGB",
      default_station_id: null,
      auto_resolve_station: false,
      can_change_station: false,
      status: "active",
    }
  );

  const existingAppUser = await findExisting(supabase, "app_users", { employee_id: employeeId });
  let appUserId: string;
  if (existingAppUser) {
    appUserId = existingAppUser;
  } else {
    const pinPepperEnv = process.env.PIN_PEPPER;
    if (!pinPepperEnv) throw new Error("PIN_PEPPER is not set");
    const { data: inserted, error } = await supabase
      .from("app_users")
      .insert({
        organization_id: organizationId,
        employee_id: employeeId,
        pin_lookup_hash: hashPinLookup("9999", pinPepperEnv),
        pin_hash: await hashPinForStorage("9999"),
        is_active: true,
      })
      .select("id")
      .single();
    if (!error) {
      appUserId = inserted.id as string;
    } else if (error.code === "23505") {
      const id = await findExisting(supabase, "app_users", { employee_id: employeeId });
      if (!id) throw error;
      appUserId = id;
    } else {
      throw error;
    }
  }

  const vendorId = await createTestVendor(supabase, organizationId, { namePrefix: `${TEST_PREFIX}Org B Vendor`, runId: generateRunId() });

  return { organizationId, vendorId, appUserId };
}
