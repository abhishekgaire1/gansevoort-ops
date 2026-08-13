import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * organizations.name has no unique constraint (unlike vendors), and never
 * will get one just to solve a test-fixture problem -- see the module
 * comment in tests/testFixtures.ts. That means "find-or-insert" is not
 * naturally race-safe for a shared, fixed-name organization: two
 * concurrently-running processes can both SELECT "not found" before either
 * INSERTs, and both inserts succeed, silently creating two rows with the
 * identical name instead of erroring the way a real unique constraint
 * would. This module is the single source of truth for what "the
 * canonical organization named X" means (oldest row by created_at) so that
 * scripts/test-integration-setup.ts (which may insert, but only ever runs
 * once, serially, before Vitest's concurrent workers start) and
 * tests/testFixtures.ts (which must NEVER insert -- see its own comment)
 * can never disagree about which row is canonical.
 */

/** Read-only: the oldest organization row matching `name`, or null if none
 * exists yet. Never inserts. */
export async function resolveCanonicalOrgId(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("name", name)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string) ?? null;
}

/**
 * Insert-then-resolve. ONLY safe to call from a single, non-concurrent
 * process -- never from inside a test file's own beforeAll, which is
 * exactly the race this module exists to eliminate. If a row already
 * exists (including a rerun of the setup script itself, or historical
 * duplicates left by the pre-fix racy find-or-insert), no new row is
 * inserted -- the existing oldest one is returned.
 */
export async function ensureCanonicalOrgId(supabase: SupabaseClient, name: string): Promise<string> {
  const existing = await resolveCanonicalOrgId(supabase, name);
  if (existing) return existing;

  const { error } = await supabase.from("organizations").insert({ name });
  if (error) throw error;

  const canonical = await resolveCanonicalOrgId(supabase, name);
  if (!canonical) throw new Error(`Inserted an organization named "${name}" but could not re-select it afterward.`);
  return canonical;
}
