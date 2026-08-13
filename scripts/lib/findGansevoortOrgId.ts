import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Finds the organization named exactly "Gansevoort" -- does NOT assume the
 * database contains only one organization (automated-test fixtures live in
 * their own separate organizations, e.g. "TEST RPC Fixture Org" / "TEST RPC
 * Fixture Org B" -- see tests/testFixtures.ts -- and coexisting with them is
 * expected, not an error). Aborts if zero or more than one row matches;
 * other organizations are simply ignored. Shared by dev-seed.ts and
 * dev-cleanup-test-pollution.ts so both scripts agree on exactly what
 * "Gansevoort" means.
 */
export async function findGansevoortOrgId(supabase: SupabaseClient): Promise<string> {
  const { data: gansevoortOrgs, error } = await supabase.from("organizations").select("id, name").eq("name", "Gansevoort");
  if (error) throw error;

  if (!gansevoortOrgs || gansevoortOrgs.length === 0) {
    console.error('No organization named "Gansevoort" was found. Aborting.');
    process.exit(1);
  }
  if (gansevoortOrgs.length > 1) {
    console.error(
      `Expected exactly one organization named "Gansevoort", found ${gansevoortOrgs.length}: ${JSON.stringify(gansevoortOrgs)}. Aborting.`
    );
    process.exit(1);
  }

  return gansevoortOrgs[0].id as string;
}
