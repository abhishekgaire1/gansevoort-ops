import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import readline from "node:readline/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";

/**
 * One-time (but safely re-runnable) canonical master-data setup for the
 * REAL Gansevoort DEV organization -- explicitly NOT a Supabase migration.
 * Migrations apply identically to every environment forever; a specific
 * restaurant's category taxonomy is business configuration, not schema, and
 * must never be baked into a migration that every future org would also
 * receive. Mirrors dev-seed.ts's own "seed script, not a migration"
 * reasoning and its idempotent find-or-insert-by-name style.
 *
 * ORG SAFETY: findGansevoortOrgId resolves the one real "Gansevoort"
 * organization -- this script never touches "TEST RPC Fixture Org" or any
 * other organization. Run manually: `npx tsx scripts/seed-canonical-categories.ts`.
 * Pass `--dry-run` to inspect existing categories and print the planned
 * changes without writing anything; pass `--yes` to skip the confirmation
 * prompt (same convention as dev-seed.ts).
 */

const INVENTORY_CATEGORIES = [
  "Produce",
  "Meat & Poultry",
  "Seafood",
  "Dairy & Eggs",
  "Bread & Bakery",
  "Rice, Grains & Noodles",
  "Dry Goods & Pantry",
  "Sauces, Condiments & Seasonings",
  "Frozen Foods",
  "Prepared & Refrigerated Foods",
  "Beverages",
  "Beverage Ingredients",
  "Desserts & Sweets",
  "Packaging & Disposables",
  "Cleaning & Sanitation",
  "Smallwares & Kitchen Supplies",
];

const SPEND_CATEGORY_TREE: Record<string, string[]> = {
  "Food & Beverage": [
    "Produce",
    "Meat & Poultry",
    "Seafood",
    "Dairy & Eggs",
    "Bread & Bakery",
    "Rice, Grains & Noodles",
    "Dry Goods & Pantry",
    "Sauces, Condiments & Seasonings",
    "Frozen Foods",
    "Prepared & Refrigerated Foods",
    "Beverages",
    "Beverage Ingredients",
    "Desserts & Sweets",
  ],
  "Operating Supplies": ["Packaging & Disposables", "Cleaning & Sanitation", "Smallwares & Kitchen Supplies"],
  "Other Operating Costs": ["Freight & Delivery", "Repairs & Maintenance", "Services & Fees", "Miscellaneous"],
};

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

interface Report {
  reused: string[];
  created: string[];
}

async function findOrInsertInventoryCategory(supabase: SupabaseClient, organizationId: string, name: string, report: Report, dryRun: boolean): Promise<string | null> {
  const { data: existing, error } = await supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId).ilike("name", name).maybeSingle();
  if (error) throw error;
  if (existing) {
    report.reused.push(`${existing.name} (existing row reused for canonical "${name}")`);
    return existing.id as string;
  }

  report.created.push(name);
  if (dryRun) return null;

  const { data: inserted, error: insertError } = await supabase
    .from("inventory_categories")
    .insert({ organization_id: organizationId, name })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return inserted.id as string;
}

async function findOrInsertSpendCategory(
  supabase: SupabaseClient,
  organizationId: string,
  name: string,
  parentId: string | null,
  report: Report,
  dryRun: boolean
): Promise<string | null> {
  let query = supabase.from("spend_categories").select("id, name").eq("organization_id", organizationId).ilike("name", name);
  query = parentId === null ? query.is("parent_id", null) : query.eq("parent_id", parentId);
  const { data: existing, error } = await query.maybeSingle();
  if (error) throw error;
  if (existing) {
    report.reused.push(`${existing.name} (existing row reused for canonical "${name}")`);
    return existing.id as string;
  }

  report.created.push(parentId ? `  ${name}` : name);
  if (dryRun) return null;

  const { data: inserted, error: insertError } = await supabase
    .from("spend_categories")
    .insert({ organization_id: organizationId, name, parent_id: parentId })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return inserted.id as string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");
  verifyExpectedProjectRef(supabaseUrl);

  const supabase = createClient(supabaseUrl, secretKey);
  const organizationId = await findGansevoortOrgId(supabase);

  const { data: existingCategories } = await supabase.from("inventory_categories").select("id, name, is_active").eq("organization_id", organizationId).order("name");
  const { data: existingSpendCategories } = await supabase
    .from("spend_categories")
    .select("id, name, parent_id, is_active")
    .eq("organization_id", organizationId)
    .order("name");

  console.log(`Gansevoort organization: ${organizationId}`);
  console.log(`\nExisting inventory_categories (${existingCategories?.length ?? 0}):`);
  for (const c of existingCategories ?? []) console.log(`  - ${c.name}${c.is_active ? "" : " (inactive)"}`);
  console.log(`\nExisting spend_categories (${existingSpendCategories?.length ?? 0}):`);
  for (const c of existingSpendCategories ?? []) console.log(`  - ${c.name}${c.parent_id ? " (child)" : " (root)"}${c.is_active ? "" : " (inactive)"}`);

  await confirm(
    `\nAbout to ${dryRun ? "DRY-RUN plan" : "idempotently create/reuse"} ${INVENTORY_CATEGORIES.length} canonical inventory categories and the ` +
      `${Object.keys(SPEND_CATEGORY_TREE).length}-root spend-category tree in organization "Gansevoort" (${organizationId}) at ${supabaseUrl}.`
  );

  const inventoryReport: Report = { reused: [], created: [] };
  for (const name of INVENTORY_CATEGORIES) {
    await findOrInsertInventoryCategory(supabase, organizationId, name, inventoryReport, dryRun);
  }

  const spendReport: Report = { reused: [], created: [] };
  for (const [rootName, children] of Object.entries(SPEND_CATEGORY_TREE)) {
    const rootId = await findOrInsertSpendCategory(supabase, organizationId, rootName, null, spendReport, dryRun);
    for (const childName of children) {
      await findOrInsertSpendCategory(supabase, organizationId, childName, rootId, spendReport, dryRun);
    }
  }

  console.log(`\n${dryRun ? "[DRY RUN] Would create" : "Created"} inventory categories (${inventoryReport.created.length}):`);
  for (const n of inventoryReport.created) console.log(`  + ${n}`);
  console.log(`Reused existing inventory categories (${inventoryReport.reused.length}):`);
  for (const n of inventoryReport.reused) console.log(`  = ${n}`);

  console.log(`\n${dryRun ? "[DRY RUN] Would create" : "Created"} spend categories (${spendReport.created.length}):`);
  for (const n of spendReport.created) console.log(`  +${n}`);
  console.log(`Reused existing spend categories (${spendReport.reused.length}):`);
  for (const n of spendReport.reused) console.log(`  = ${n}`);

  console.log(dryRun ? "\nDry run complete -- nothing was written." : "\nDone.");
}

main();
