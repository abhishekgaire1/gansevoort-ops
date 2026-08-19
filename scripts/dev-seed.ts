import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { randomBytes, randomInt } from "node:crypto";
import readline from "node:readline/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hashPinForStorage, hashPinLookup, isValidPinFormat } from "../app/lib/auth/pin";
import { envOrGenerated } from "./lib/envOrGenerated";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";

/**
 * Dev-only test-data seed. NOT a Supabase migration: migrations apply
 * identically to every environment forever, so fake stations/employees/
 * items don't belong there -- same reasoning the real seed migration's own
 * header comment uses for seeding nothing but real, documented data.
 *
 * Run manually: `npm run db:seed:dev`. Never wired into build/start/CI.
 *
 * Idempotent by select-by-natural-key, insert-if-missing (not .upsert(),
 * since the relevant uniqueness constraints are case-insensitive expression
 * indexes .upsert() can't target). Safe to run repeatedly.
 *
 * Does NOT call record_inventory_withdrawal: inventory_movements/
 * inventory_movement_lines/audit_events are append-only even for
 * service_role, so any demo write here would become permanent, unremovable
 * history and break repeatability. Demo withdrawals are a separate, manual,
 * explicit action.
 */

const DEV = "DEV ";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function randomPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function confirm(message: string): Promise<void> {
  if (process.argv.includes("--yes")) {
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} Type "yes" to continue: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("Aborted.");
    process.exit(1);
  }
}

async function findOrInsertNamed(
  supabase: SupabaseClient,
  table: string,
  scope: Record<string, string>,
  name: string,
  insertRow: Record<string, unknown>
): Promise<string> {
  let query = supabase.from(table).select("id").ilike("name", name);
  for (const [key, value] of Object.entries(scope)) {
    query = query.eq(key, value);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (data) return data.id as string;

  const { data: inserted, error: insertError } = await supabase
    .from(table)
    .insert(insertRow)
    .select("id")
    .single();
  if (insertError) throw insertError;
  console.log(`  created ${table}: ${name}`);
  return inserted.id as string;
}

async function findOrCreateAuthUser(
  supabase: SupabaseClient,
  email: string,
  password: string,
  /** True only when the caller's password came from an explicitly-set env
   * var, not envOrGenerated()'s random fallback. An existing auth user's
   * password is a one-way hash we can never read back to compare against,
   * so there's no way to detect "already matches" -- we only ever write it
   * when the operator deliberately supplied a value to converge to,
   * otherwise a re-run would silently reset a real password to a fresh
   * random one every time. */
  passwordWasExplicitlySupplied: boolean
): Promise<string> {
  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (!error && created.user) {
    console.log(`  created auth user: ${email}`);
    return created.user.id;
  }

  const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) throw listError;
  const existing = listData.users.find((u) => u.email === email);
  if (!existing) throw error ?? new Error(`Could not create or find auth user ${email}`);

  if (passwordWasExplicitlySupplied) {
    // Re-syncs an existing seeded auth user's password to match
    // DEV_SEED_*_PASSWORD when it was set/changed after the user was
    // originally created (e.g. the first seed run generated a random
    // password that was never saved). Same auth user id/row throughout --
    // never deleted or recreated. Never logs the password itself.
    const { error: updateError } = await supabase.auth.admin.updateUserById(existing.id, { password });
    if (updateError) throw updateError;
    console.log(`  updated password for existing auth user: ${email}`);
  }

  return existing.id;
}

interface EmployeeSpec {
  employeeCode: string;
  firstName: string;
  lastName: string;
  roleName: "employee" | "manager";
  pinEnvVar: string;
  defaultStationName: string | null;
  autoResolveStation: boolean;
  canChangeStation: boolean;
  authEmail?: string;
  authPasswordEnvVar?: string;
}

async function ensureEmployee(
  supabase: SupabaseClient,
  organizationId: string,
  pinPepper: string,
  roleIdByName: Map<string, string>,
  stationIdByName: Map<string, string>,
  spec: EmployeeSpec
): Promise<void> {
  const { data: existingEmployee, error: employeeLookupError } = await supabase
    .from("employees")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("employee_code", spec.employeeCode)
    .maybeSingle();
  if (employeeLookupError) throw employeeLookupError;

  const defaultStationId = spec.defaultStationName ? stationIdByName.get(spec.defaultStationName) ?? null : null;

  let employeeId: string;
  if (existingEmployee) {
    employeeId = existingEmployee.id as string;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("employees")
      .insert({
        organization_id: organizationId,
        first_name: spec.firstName,
        last_name: spec.lastName,
        employee_code: spec.employeeCode,
        default_station_id: defaultStationId,
        auto_resolve_station: spec.autoResolveStation,
        can_change_station: spec.canChangeStation,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    employeeId = inserted.id as string;
    console.log(`  created employee: ${spec.firstName} ${spec.lastName} (${spec.employeeCode})`);
  }

  const { data: existingAppUser } = await supabase
    .from("app_users")
    .select("id")
    .eq("employee_id", employeeId)
    .maybeSingle();

  let authUserId: string | null = null;
  if (spec.authEmail && spec.authPasswordEnvVar) {
    const { value: password, wasGenerated: passwordWasGenerated } = envOrGenerated(spec.authPasswordEnvVar, randomPassword);
    if (passwordWasGenerated) {
      console.log(`  generated password for ${spec.authEmail}: ${password}  (not persisted anywhere, save it now)`);
    }
    authUserId = await findOrCreateAuthUser(supabase, spec.authEmail, password, !passwordWasGenerated);
  }

  let appUserId: string;
  if (existingAppUser) {
    appUserId = existingAppUser.id as string;
  } else {
    const { value: pin, wasGenerated: pinWasGenerated } = envOrGenerated(spec.pinEnvVar, randomPin);
    if (!isValidPinFormat(pin)) {
      throw new Error(
        `${spec.pinEnvVar} is set to "${pin}", which is not a valid PIN (must be exactly 6 digits). ` +
          `Fix .env.local, or leave it blank to auto-generate one.`
      );
    }
    if (pinWasGenerated) {
      console.log(`  generated PIN for ${spec.firstName} ${spec.lastName}: ${pin}  (not persisted anywhere, save it now)`);
    }

    const { data: inserted, error: insertError } = await supabase
      .from("app_users")
      .insert({
        organization_id: organizationId,
        employee_id: employeeId,
        auth_user_id: authUserId,
        pin_lookup_hash: hashPinLookup(pin, pinPepper),
        pin_hash: await hashPinForStorage(pin),
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    appUserId = inserted.id as string;
    console.log(`  created app_user for ${spec.firstName} ${spec.lastName}`);
  }

  const roleId = roleIdByName.get(spec.roleName);
  if (!roleId) throw new Error(`Role ${spec.roleName} not found -- run base migrations first.`);

  const { data: existingRole } = await supabase
    .from("user_roles")
    .select("app_user_id")
    .eq("app_user_id", appUserId)
    .eq("role_id", roleId)
    .maybeSingle();

  if (!existingRole) {
    const { error: roleInsertError } = await supabase
      .from("user_roles")
      .insert({ app_user_id: appUserId, role_id: roleId, organization_id: organizationId });
    if (roleInsertError) throw roleInsertError;
    console.log(`  granted role ${spec.roleName} to ${spec.firstName} ${spec.lastName}`);
  }
}

interface ItemUnitSpec {
  unitCode: string;
  conversionFactor: number | null;
  requiresActualMeasurement: boolean;
  isDefaultEntryUnit: boolean;
}

interface ItemSpec {
  name: string;
  categoryName: string;
  baseUnitCode: string;
  units: ItemUnitSpec[];
}

async function ensureItem(
  supabase: SupabaseClient,
  organizationId: string,
  categoryIdByName: Map<string, string>,
  unitIdByCode: Map<string, string>,
  spec: ItemSpec
): Promise<string> {
  const categoryId = categoryIdByName.get(spec.categoryName);
  if (!categoryId) throw new Error(`Category ${spec.categoryName} not found.`);
  const baseUnitId = unitIdByCode.get(spec.baseUnitCode);
  if (!baseUnitId) throw new Error(`Unit ${spec.baseUnitCode} not found.`);

  const itemId = await findOrInsertNamed(
    supabase,
    "inventory_items",
    { organization_id: organizationId },
    spec.name,
    { organization_id: organizationId, category_id: categoryId, base_unit_id: baseUnitId, name: spec.name }
  );

  for (const unitSpec of spec.units) {
    const unitId = unitIdByCode.get(unitSpec.unitCode);
    if (!unitId) throw new Error(`Unit ${unitSpec.unitCode} not found.`);

    const { data: existing } = await supabase
      .from("inventory_item_units")
      .select("id")
      .eq("inventory_item_id", itemId)
      .eq("unit_id", unitId)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase.from("inventory_item_units").insert({
        inventory_item_id: itemId,
        unit_id: unitId,
        conversion_factor: unitSpec.conversionFactor,
        requires_actual_measurement: unitSpec.requiresActualMeasurement,
        is_default_entry_unit: unitSpec.isDefaultEntryUnit,
      });
      if (error) throw error;
      console.log(`  created item unit: ${spec.name} / ${unitSpec.unitCode}`);
    }
  }

  return itemId;
}

async function ensureControlRule(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  stationId: string | null,
  thresholdQuantity: number
): Promise<void> {
  let query = supabase
    .from("control_rules")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", inventoryItemId)
    .eq("rule_type", "HIGH_WITHDRAWAL");
  query = stationId ? query.eq("station_id", stationId) : query.is("station_id", null);

  const { data: existing } = await query.maybeSingle();
  if (existing) return;

  const { error } = await supabase.from("control_rules").insert({
    organization_id: organizationId,
    rule_type: "HIGH_WITHDRAWAL",
    inventory_item_id: inventoryItemId,
    station_id: stationId,
    threshold_quantity: thresholdQuantity,
  });
  if (error) throw error;
  console.log(`  created control_rule for item ${inventoryItemId} (station: ${stationId ?? "default"})`);
}

async function main(): Promise<void> {
  if (process.env.ALLOW_DEV_SEED !== "true") {
    console.error("ALLOW_DEV_SEED=true is required to run this script.");
    process.exit(1);
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");
  const pinPepper = requireEnv("PIN_PEPPER");

  verifyExpectedProjectRef(supabaseUrl);
  console.log(`Connected to: ${supabaseUrl}`);

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const organizationId = await findGansevoortOrgId(supabase);

  await confirm(`About to seed DEV test data into organization "Gansevoort" (${organizationId}) at ${supabaseUrl}.`);

  const { data: locations, error: locationError } = await supabase
    .from("locations")
    .select("id")
    .eq("organization_id", organizationId)
    .limit(1);
  if (locationError) throw locationError;
  if (!locations || locations.length === 0) {
    throw new Error("No location found for organization Gansevoort -- run the base migrations first.");
  }
  const locationId = locations[0].id as string;

  console.log("Seeding stations...");
  const stationNames = [`${DEV}Grill Station`, `${DEV}Salad Station`, `${DEV}Beverage Station`];
  const stationIdByName = new Map<string, string>();
  for (const name of stationNames) {
    const id = await findOrInsertNamed(
      supabase,
      "stations",
      { organization_id: organizationId, location_id: locationId },
      name,
      { organization_id: organizationId, location_id: locationId, name }
    );
    stationIdByName.set(name, id);
  }

  console.log("Seeding categories...");
  const categoryNames = [`${DEV}Meat`, `${DEV}Dairy`, `${DEV}Dry Goods`];
  const categoryIdByName = new Map<string, string>();
  for (const name of categoryNames) {
    const id = await findOrInsertNamed(
      supabase,
      "inventory_categories",
      { organization_id: organizationId },
      name,
      { organization_id: organizationId, name }
    );
    categoryIdByName.set(name, id);
  }

  const { data: units, error: unitsError } = await supabase.from("units").select("id, code");
  if (unitsError) throw unitsError;
  const unitIdByCode = new Map((units ?? []).map((u) => [u.code as string, u.id as string]));

  console.log("Seeding inventory items and item units...");
  const itemIdByName = new Map<string, string>();
  // Withdrawal-unit simplification (kiosk UI plan): the kiosk withdraws an
  // item only in its own base unit, which record_inventory_withdrawal's
  // enforce_movement_line_measurement() trigger and the
  // inventory_movement_lines_item_unit_fk constraint only accept when an
  // ACTIVE inventory_item_units row exists for (item, base_unit_id) --
  // neither was changed to special-case this. So every item below gets a
  // self-referencing base-unit row (conversionFactor 1, no measurement
  // required) alongside whatever packaging units it already has. Packaging
  // units (BOX/CASE/...) are left in place: they remain for a future
  // purchasing/receiving workflow, they're just never offered by the kiosk.
  const itemSpecs: ItemSpec[] = [
    {
      // Case a: WEIGHT item. Packaging (BOX) stays for future receiving;
      // the kiosk only ever withdraws in LB.
      name: `${DEV}Chicken Thigh`,
      categoryName: `${DEV}Meat`,
      baseUnitCode: "LB",
      units: [
        { unitCode: "BOX", conversionFactor: null, requiresActualMeasurement: true, isDefaultEntryUnit: false },
        { unitCode: "LB", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true },
      ],
    },
    {
      // Case b: COUNT item whose base unit was already its only entry unit.
      name: `${DEV}Napkins`,
      categoryName: `${DEV}Dry Goods`,
      baseUnitCode: "PIECE",
      units: [{ unitCode: "PIECE", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true }],
    },
    {
      // Case c: COUNT item. Packaging (BOX of 360) stays for future
      // receiving; the kiosk only ever withdraws in PIECE.
      name: `${DEV}Eggs`,
      categoryName: `${DEV}Dry Goods`,
      baseUnitCode: "PIECE",
      units: [
        { unitCode: "BOX", conversionFactor: 360, requiresActualMeasurement: false, isDefaultEntryUnit: false },
        { unitCode: "PIECE", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true },
      ],
    },
    {
      name: `${DEV}Ketchup`,
      categoryName: `${DEV}Dry Goods`,
      baseUnitCode: "BOTTLE",
      units: [{ unitCode: "BOTTLE", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true }],
    },
    {
      // Packaging (CASE) stays for future receiving; the kiosk only ever
      // withdraws in LB.
      name: `${DEV}Rice`,
      categoryName: `${DEV}Dry Goods`,
      baseUnitCode: "LB",
      units: [
        { unitCode: "CASE", conversionFactor: 25, requiresActualMeasurement: false, isDefaultEntryUnit: false },
        { unitCode: "LB", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true },
      ],
    },
    {
      // Case e: VOLUME item, to exercise the third tracking basis end to end.
      name: `${DEV}Cooking Oil`,
      categoryName: `${DEV}Dry Goods`,
      baseUnitCode: "GAL",
      units: [{ unitCode: "GAL", conversionFactor: 1, requiresActualMeasurement: false, isDefaultEntryUnit: true }],
    },
  ];
  for (const spec of itemSpecs) {
    const id = await ensureItem(supabase, organizationId, categoryIdByName, unitIdByCode, spec);
    itemIdByName.set(spec.name, id);
  }

  console.log("Seeding control rules...");
  // Case d: deliberately low threshold so a realistic demo entry trips it.
  await ensureControlRule(
    supabase,
    organizationId,
    itemIdByName.get(`${DEV}Chicken Thigh`)!,
    stationIdByName.get(`${DEV}Grill Station`)!,
    5
  );
  // High threshold default rule -- a normal demo entry should not trip this.
  await ensureControlRule(supabase, organizationId, itemIdByName.get(`${DEV}Eggs`)!, null, 1000);
  // Napkins/Ketchup/Rice/Cooking Oil intentionally get no rule: demonstrates
  // "no configured rule -> no check possible."

  console.log("Seeding roles reference...");
  const { data: roles, error: rolesError } = await supabase.from("roles").select("id, name");
  if (rolesError) throw rolesError;
  const roleIdByName = new Map((roles ?? []).map((r) => [r.name as string, r.id as string]));

  console.log("Seeding employees...");
  const employeeSpecs: EmployeeSpec[] = [
    {
      // auto-resolve, locked to default station
      employeeCode: "DEV-EMP-1",
      firstName: "Dev",
      lastName: "EmployeeOne",
      roleName: "employee",
      pinEnvVar: "DEV_SEED_EMPLOYEE_1_PIN",
      defaultStationName: `${DEV}Grill Station`,
      autoResolveStation: true,
      canChangeStation: false,
    },
    {
      // auto-resolve, but allowed to change station -- the primary
      // "normal Dev login" fixture for the 2A.5 kiosk flow (PIN -> auto
      // resolves straight to this default station -> Change Station still
      // available from the header). Pinned to Beverage Station to match
      // the browser-testing walkthrough exactly.
      employeeCode: "DEV-EMP-2",
      firstName: "Dev",
      lastName: "EmployeeTwo",
      roleName: "employee",
      pinEnvVar: "DEV_SEED_EMPLOYEE_2_PIN",
      defaultStationName: `${DEV}Beverage Station`,
      autoResolveStation: true,
      canChangeStation: true,
    },
    {
      // manual station selection every time
      employeeCode: "DEV-EMP-3",
      firstName: "Dev",
      lastName: "EmployeeThree",
      roleName: "employee",
      pinEnvVar: "DEV_SEED_EMPLOYEE_3_PIN",
      defaultStationName: null,
      autoResolveStation: false,
      canChangeStation: false,
    },
    {
      employeeCode: "DEV-MGR-1",
      firstName: "Dev",
      lastName: "ManagerOne",
      roleName: "manager",
      pinEnvVar: "DEV_SEED_MANAGER_PIN",
      defaultStationName: null,
      autoResolveStation: false,
      canChangeStation: false,
      authEmail: envOrGenerated("DEV_SEED_MANAGER_EMAIL", () => "dev-manager@gansevoort.local").value,
      authPasswordEnvVar: "DEV_SEED_MANAGER_PASSWORD",
    },
    {
      // A second, distinct manager -- for manually exercising maker-checker
      // workflows (Milestone 2A.2) that require a DIFFERENT manager to
      // verify/return a document than the one who uploaded/prepared it.
      // Follows the exact same ensureEmployee path as DEV-MGR-1 above --
      // no separate seeding pathway.
      employeeCode: "DEV-MGR-2",
      firstName: "Dev",
      lastName: "ManagerTwo",
      roleName: "manager",
      pinEnvVar: "DEV_SEED_MANAGER_2_PIN",
      defaultStationName: null,
      autoResolveStation: false,
      canChangeStation: false,
      authEmail: envOrGenerated("DEV_SEED_MANAGER_2_EMAIL", () => "dev-manager-2@gansevoort.local").value,
      authPasswordEnvVar: "DEV_SEED_MANAGER_2_PASSWORD",
    },
  ];
  for (const spec of employeeSpecs) {
    await ensureEmployee(supabase, organizationId, pinPepper, roleIdByName, stationIdByName, spec);
  }

  console.log("Dev seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
