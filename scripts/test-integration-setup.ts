import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { ensureCanonicalOrgId, resolveCanonicalOrgId } from "./lib/canonicalOrg";

/**
 * SERIAL, one-time-per-run setup for the automated integration test suite.
 * Wired into `npm run test:integration` (see package.json) to run BEFORE
 * `vitest run` starts -- Vitest runs separate test files concurrently by
 * default, and a fixed-name organization has no unique constraint to
 * arbitrate a race between them (see scripts/lib/canonicalOrg.ts). Running
 * this once, serially, first means the canonical "TEST RPC Fixture Org"
 * (and its required location) already exists by the time any .rpc.test.ts
 * file's beforeAll runs, so there is nothing left to race over.
 *
 * tests/testFixtures.ts now only ever RESOLVES this organization -- it
 * never creates one, and fails with a clear, actionable error if this
 * script hasn't been run first (see resolveTestOrgId there).
 *
 * Touches nothing else: no Gansevoort data, no "TEST RPC Fixture Org B"
 * (that organization is created on demand by a single, non-concurrent test
 * path -- see setupOtherOrgFixtures in tests/testFixtures.ts -- and does
 * not need this serialization).
 */

const TEST_ORG_NAME = "TEST RPC Fixture Org";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");

  verifyExpectedProjectRef(supabaseUrl);

  const supabase = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const before = await resolveCanonicalOrgId(supabase, TEST_ORG_NAME);
  const organizationId = await ensureCanonicalOrgId(supabase, TEST_ORG_NAME);
  console.log(
    before
      ? `Reusing existing canonical "${TEST_ORG_NAME}": ${organizationId}`
      : `Created canonical "${TEST_ORG_NAME}": ${organizationId}`
  );

  const { data: existingLocation, error: locationSelectError } = await supabase
    .from("locations")
    .select("id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (locationSelectError) throw locationSelectError;

  if (existingLocation) {
    console.log(`Reusing existing location: ${existingLocation.id}`);
    // is_storage_eligible defaults to false as of 20260811100073 -- ensure
    // the canonical fixture location stays explicitly eligible even if it
    // predates that migration's usage-based backfill somehow missed it.
    const { error: eligibilityError } = await supabase.from("locations").update({ is_storage_eligible: true }).eq("id", existingLocation.id).eq("is_storage_eligible", false);
    if (eligibilityError) throw eligibilityError;
  } else {
    const { data: inserted, error: locationInsertError } = await supabase
      .from("locations")
      // is_storage_eligible explicit, never relying on the DB default.
      .insert({ organization_id: organizationId, name: `${TEST_ORG_NAME} Location`, timezone: "America/New_York", is_storage_eligible: true })
      .select("id")
      .single();
    if (locationInsertError) throw locationInsertError;
    console.log(`Created location: ${inserted.id}`);
  }

  console.log("Integration test setup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
