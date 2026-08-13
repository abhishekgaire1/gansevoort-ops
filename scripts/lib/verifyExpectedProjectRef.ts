import { readFileSync } from "node:fs";

/** Positive verification that a script is talking to the expected linked
 * Supabase project, beyond just possessing a service-role key -- compares
 * the project ref embedded in SUPABASE_URL against the Supabase CLI's own
 * linked-project marker. Shared by every script that can write to (or, for
 * dev-cleanup-test-pollution.ts, delete from) the linked database, so a
 * mistargeted SUPABASE_URL is refused identically everywhere rather than
 * re-implemented per script. */
export function verifyExpectedProjectRef(supabaseUrl: string): void {
  let expectedRef: string;
  try {
    expectedRef = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  } catch {
    console.error(
      "Could not read supabase/.temp/project-ref (the Supabase CLI's linked-project marker). " +
        'Run "supabase link" first so this script can verify it is pointed at the right project.'
    );
    process.exit(1);
  }

  const actualRef = new URL(supabaseUrl).hostname.split(".")[0];
  if (actualRef !== expectedRef) {
    console.error(
      `SUPABASE_URL project ref "${actualRef}" does not match the linked project "${expectedRef}". Aborting.`
    );
    process.exit(1);
  }
}
