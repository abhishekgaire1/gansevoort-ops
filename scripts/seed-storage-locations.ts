import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import readline from "node:readline/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";

/**
 * One-time (but safely re-runnable) storage-location master-data setup for
 * the REAL Gansevoort DEV organization -- explicitly NOT a Supabase
 * migration, same reasoning as scripts/seed-canonical-categories.ts.
 *
 * public.locations is confirmed (by inspection of 20260811100002,
 * 20260811100005, and 20260811100040) to be the SAME location dimension
 * used for:
 *   - stations.location_id (every kiosk station belongs to one)
 *   - inventory_movements.location_id (the authoritative inventory-posting
 *     location on every withdrawal, resolved from the station's own
 *     location_id)
 *   - receipts.default_location_id / receipt_lines.location_id (exactly
 *     what this milestone's receiving UI needs)
 * -- so these five storage locations are the correct, single dimension to
 * seed, not a new concept.
 *
 * Never touches "TEST RPC Fixture Org" or any other organization, and
 * never renames/removes the existing "Gansevoort Liberty Market — WTC"
 * row -- this only ADDS the five approved storage locations, idempotently.
 *
 * Milestone 2A.5 (20260811100073) added locations.is_storage_eligible,
 * defaulting to false and backfilled true only for locations with actual
 * PRE-EXISTING inventory/receiving usage (a generic, data-driven migration
 * rule -- never a name match). These five names are exactly the set THIS
 * script already declares authoritative for Gansevoort storage, so on
 * every run it also explicitly marks each one is_storage_eligible = true
 * -- on insert for a newly created row, and via an idempotent UPDATE for a
 * reused row the migration's usage-based backfill didn't happen to catch
 * (e.g. a location seeded here but never yet actually received into).
 *
 * Run manually: `npx tsx scripts/seed-storage-locations.ts`. `--dry-run`
 * inspects and prints the plan without writing; `--yes` skips the
 * confirmation prompt.
 */

const STORAGE_LOCATIONS = ["Central Walk-In", "Central Freezer", "Dry Storage near Walk-In", "Dry Storage C2", "Dry Storage C3"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function confirm(message: string): Promise<void> {
  if (process.argv.includes("--yes") || process.argv.includes("--dry-run")) {
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

async function findOrInsertLocation(
  supabase: SupabaseClient,
  organizationId: string,
  name: string,
  timezone: string,
  dryRun: boolean
): Promise<{ created: boolean; upgraded: boolean; name: string }> {
  const { data: existing, error } = await supabase.from("locations").select("id, name, is_storage_eligible").eq("organization_id", organizationId).ilike("name", name).maybeSingle();
  if (error) throw error;
  if (existing) {
    if (existing.is_storage_eligible) {
      return { created: false, upgraded: false, name: existing.name as string };
    }
    if (dryRun) {
      return { created: false, upgraded: true, name: existing.name as string };
    }
    const { error: updateError } = await supabase.from("locations").update({ is_storage_eligible: true }).eq("id", existing.id);
    if (updateError) throw updateError;
    return { created: false, upgraded: true, name: existing.name as string };
  }

  if (dryRun) {
    return { created: true, upgraded: false, name };
  }

  const { error: insertError } = await supabase.from("locations").insert({ organization_id: organizationId, name, timezone, is_storage_eligible: true });
  if (insertError) throw insertError;
  return { created: true, upgraded: false, name };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");
  verifyExpectedProjectRef(supabaseUrl);

  const supabase = createClient(supabaseUrl, secretKey);
  const organizationId = await findGansevoortOrgId(supabase);

  const { data: existingLocations } = await supabase.from("locations").select("id, name, is_active, timezone").eq("organization_id", organizationId).order("name");
  console.log(`Gansevoort organization: ${organizationId}`);
  console.log(`\nExisting locations (${existingLocations?.length ?? 0}):`);
  for (const l of existingLocations ?? []) console.log(`  - ${l.name}${l.is_active ? "" : " (inactive)"} [${l.timezone}]`);

  // Match the existing "Gansevoort Liberty Market — WTC" row's own
  // timezone rather than hardcoding a guess independent of it.
  const timezone = (existingLocations ?? []).find((l) => l.timezone)?.timezone ?? "America/New_York";

  await confirm(
    `\nAbout to ${dryRun ? "DRY-RUN plan" : "idempotently create/reuse"} ${STORAGE_LOCATIONS.length} storage locations in organization "Gansevoort" (${organizationId}) at ${supabaseUrl}. The existing "Gansevoort Liberty Market — WTC" row is never touched.`
  );

  const created: string[] = [];
  const upgraded: string[] = [];
  const reused: string[] = [];
  for (const name of STORAGE_LOCATIONS) {
    const result = await findOrInsertLocation(supabase, organizationId, name, timezone as string, dryRun);
    if (result.created) created.push(result.name);
    else if (result.upgraded) upgraded.push(result.name);
    else reused.push(result.name);
  }

  console.log(`\n${dryRun ? "[DRY RUN] Would create" : "Created"} (${created.length}):`);
  for (const n of created) console.log(`  + ${n}`);
  console.log(`${dryRun ? "[DRY RUN] Would mark" : "Marked"} is_storage_eligible=true on existing row (${upgraded.length}):`);
  for (const n of upgraded) console.log(`  ↑ ${n}`);
  console.log(`Reused, already eligible (${reused.length}):`);
  for (const n of reused) console.log(`  = ${n}`);

  console.log(dryRun ? "\nDry run complete -- nothing was written." : "\nDone.");
}

main();
