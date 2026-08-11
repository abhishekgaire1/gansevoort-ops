import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";

/**
 * Shared fixture setup for the manual/on-demand integration tests
 * (pin.integration.test.ts, withdrawal.rpc.test.ts). These tests touch the
 * linked Supabase dev database directly and are NOT run in CI (project
 * testing policy: only pure/local deterministic tests run automatically).
 *
 * Fixtures are found-or-created (idempotent, same pattern as
 * scripts/dev-seed.ts) so repeated manual runs reuse the same master-data
 * rows rather than accumulating new ones -- only the movements/exceptions/
 * audit_events actually produced by a test run accumulate, which is
 * unavoidable: those tables are append-only even for service_role.
 */

const TEST_PREFIX = "TEST RPC Fixture ";

export interface RpcTestFixtures {
  supabase: SupabaseClient;
  organizationId: string;
  stationId: string;
  otherStationId: string;
  variableWeightItemId: string;
  variableWeightBoxUnitId: string;
  fixedConversionItemId: string;
  fixedConversionCaseUnitId: string;
  noRuleItemId: string;
  noRuleUnitId: string;
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
}

async function findOrgId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("name", "Gansevoort").single();
  if (error) throw error;
  return data.id as string;
}

async function findOrInsert(
  supabase: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  insertRow: Record<string, unknown>
): Promise<string> {
  let query = supabase.from(table).select("id");
  for (const [key, value] of Object.entries(match)) {
    query = query.eq(key, value);
  }
  const { data } = await query.maybeSingle();
  if (data) return data.id as string;

  const { data: inserted, error } = await supabase.from(table).insert(insertRow).select("id").single();
  if (error) throw error;
  return inserted.id as string;
}

export async function setupRpcTestFixtures(): Promise<RpcTestFixtures> {
  const supabase = getServiceRoleClient();
  const organizationId = await findOrgId(supabase);

  const { data: location, error: locationError } = await supabase
    .from("locations")
    .select("id")
    .eq("organization_id", organizationId)
    .limit(1)
    .single();
  if (locationError || !location) throw locationError ?? new Error("No location found for organization Gansevoort");
  const locationId = location.id as string;

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

  // Low threshold so an over-threshold test withdrawal reliably trips it.
  const { data: existingRule } = await supabase
    .from("control_rules")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", variableWeightItemId)
    .eq("station_id", stationId)
    .maybeSingle();
  if (!existingRule) {
    await supabase.from("control_rules").insert({
      organization_id: organizationId,
      rule_type: "HIGH_WITHDRAWAL",
      inventory_item_id: variableWeightItemId,
      station_id: stationId,
      threshold_quantity: 10,
    });
  }

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

    const { data: existingAppUser } = await supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();
    if (existingAppUser) return existingAppUser.id as string;

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
    if (error) throw error;
    return inserted.id as string;
  }

  const lockedEmployeePin = "111111";
  const lockedEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-LOCKED", "TestLocked", lockedEmployeePin, {
    defaultStationId: stationId,
    autoResolveStation: true,
    canChangeStation: false,
    isActive: true,
  });

  const changeableEmployeePin = "222222";
  const changeableEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-CHANGEABLE", "TestChangeable", changeableEmployeePin, {
    defaultStationId: stationId,
    autoResolveStation: true,
    canChangeStation: true,
    isActive: true,
  });

  const inactiveEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-INACTIVE", "TestInactive", "333333", {
    defaultStationId: null,
    autoResolveStation: false,
    canChangeStation: false,
    isActive: false,
  });

  const mustPickEmployeePin = "444444";
  const mustPickEmployeeAppUserId = await ensureEmployeeAppUser("TEST-RPC-MUST-PICK", "TestMustPick", mustPickEmployeePin, {
    defaultStationId: null,
    autoResolveStation: false,
    canChangeStation: false,
    isActive: true,
  });

  return {
    supabase,
    organizationId,
    stationId,
    otherStationId,
    variableWeightItemId,
    variableWeightBoxUnitId: boxUnitId,
    fixedConversionItemId,
    fixedConversionCaseUnitId: caseUnitId,
    noRuleItemId,
    noRuleUnitId: pieceUnitId,
    wrongUnitId: galUnitId,
    lockedEmployeeAppUserId,
    lockedEmployeePin,
    changeableEmployeeAppUserId,
    changeableEmployeePin,
    inactiveEmployeeAppUserId,
    mustPickEmployeeAppUserId,
    mustPickEmployeePin,
  };
}
