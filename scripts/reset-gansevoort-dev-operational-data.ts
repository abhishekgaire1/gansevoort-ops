import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";

/**
 * DEV-ONLY operational/transactional reset for the REAL Gansevoort DEV
 * organization -- explicitly NOT a migration, NOT a manager UI action, and
 * never runnable by accident:
 *
 *   Report-only (default):  npx tsx scripts/reset-gansevoort-dev-operational-data.ts
 *   Execute:                ALLOW_DEV_RESET=true npx tsx scripts/reset-gansevoort-dev-operational-data.ts --execute
 *
 * Safety stack (defense in depth):
 * 1. verifyExpectedProjectRef -- refuses a mistargeted SUPABASE_URL.
 * 2. findGansevoortOrgId -- fails closed unless EXACTLY one organization
 *    named "Gansevoort" exists; TEST fixture orgs are never candidates.
 * 3. Report-only by default: without --execute AND ALLOW_DEV_RESET=true it
 *    only prints counts and writes the pre-reset manifest, deleting nothing.
 * 4. The actual deletion happens in reset_dev_organization_operational_data
 *    (20260811100065), which independently re-verifies: the DEV fingerprint
 *    (the integration-test fixture org must exist -- production never has
 *    it), the org-name allow-list, and an exact confirmation phrase.
 *
 * What it clears vs. preserves is documented in the migration header; this
 * script's own job is the manifest, the before/after proof, and cleaning up
 * the orphaned Storage objects the database-side reset cannot touch.
 */

const OPERATIONAL_TABLES = [
  "exceptions",
  "purchase_document_inventory_posting_lines",
  "inventory_stock_references",
  "purchase_document_inventory_postings",
  "inventory_movement_lines",
  "inventory_movements",
  "user_notifications",
  "purchase_document_line_invoice_unit_confirmations",
  "purchase_document_line_classifications",
  "purchase_document_classification_runs",
  "receipt_lines",
  "receipts",
  "purchase_document_lines",
  "purchase_documents",
  "document_delivery_verifier_corrections",
  "document_archives",
  "document_extractions",
  "documents",
  "pin_verify_rate_limits",
] as const;

const MASTER_TABLES = [
  "locations",
  "stations",
  "employees",
  "app_users",
  "units",
  "inventory_categories",
  "inventory_items",
  "inventory_item_units",
  "spend_categories",
  "vendors",
  "vendor_item_mappings",
  "control_rules",
  "audit_events",
] as const;

const ORG_UNSCOPED_TABLES = new Set(["units", "inventory_item_units"]);

async function countRows(supabase: SupabaseClient, table: string, organizationId: string | null): Promise<number> {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (organizationId && !ORG_UNSCOPED_TABLES.has(table)) {
    query = query.eq("organization_id", organizationId);
  }
  const { count, error } = await query;
  if (error) throw new Error(`count(${table}): ${error.message}`);
  return count ?? 0;
}

async function main() {
  const execute = process.argv.includes("--execute");
  if (execute && process.env.ALLOW_DEV_RESET !== "true") {
    console.error("--execute requires ALLOW_DEV_RESET=true in the environment. Aborting.");
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    console.error("SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env.local. Aborting.");
    process.exit(1);
  }
  verifyExpectedProjectRef(supabaseUrl);

  const supabase = createClient(supabaseUrl, secretKey);
  const organizationId = await findGansevoortOrgId(supabase);
  console.log(`Gansevoort DEV organization: ${organizationId}\n`);

  // TEST-org snapshot -- proven untouched after execution.
  const { data: testOrgs } = await supabase.from("organizations").select("id, name").like("name", "TEST RPC Fixture%");
  const testOrgSnapshots: Record<string, Record<string, number>> = {};
  for (const org of testOrgs ?? []) {
    const snapshot: Record<string, number> = {};
    for (const table of ["documents", "purchase_documents", "receipts", "inventory_movements", "inventory_items", "vendors"]) {
      snapshot[table] = await countRows(supabase, table, org.id as string);
    }
    testOrgSnapshots[`${org.name} (${org.id})`] = snapshot;
  }

  console.log("=== OPERATIONAL rows that WILL BE DELETED (Gansevoort only) ===");
  const operationalCounts: Record<string, number> = {};
  for (const table of OPERATIONAL_TABLES) {
    operationalCounts[table] = await countRows(supabase, table, organizationId);
    console.log(`  ${table}: ${operationalCounts[table]}`);
  }

  // Orphaned AI proposals (deleted) vs confirmed items (preserved).
  const { data: pendingProposals } = await supabase
    .from("inventory_items")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("approval_status", "PENDING_REVIEW")
    .eq("created_via", "AI_PROPOSED");
  console.log(`  ai_proposed_pending_inventory_items: ${(pendingProposals ?? []).length}`);

  console.log("\n=== MASTER DATA that will be PRESERVED (Gansevoort) ===");
  const masterCounts: Record<string, number> = {};
  for (const table of MASTER_TABLES) {
    masterCounts[table] = await countRows(supabase, table, organizationId);
    console.log(`  ${table}: ${masterCounts[table]}`);
  }

  // Confirmed vendor-item learning -- reported explicitly, never deleted.
  const { data: mappings } = await supabase
    .from("vendor_item_mappings")
    .select("id, vendor_id, match_basis, vendor_sku, normalized_description, inventory_item_id, is_active")
    .eq("organization_id", organizationId);
  console.log(`\n=== vendor_item_mappings PRESERVED: ${(mappings ?? []).length} (confirmed learned data) ===`);

  // Storage objects behind the documents being deleted (DB reset can't
  // touch Storage) -- collected now, removed only on --execute.
  const { data: docRows } = await supabase.from("documents").select("id, storage_path").eq("organization_id", organizationId);
  const storagePaths = (docRows ?? []).map((d) => d.storage_path as string).filter(Boolean);

  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: execute ? "EXECUTE" : "REPORT_ONLY",
    gansevoortOrganizationId: organizationId,
    operationalCountsToDelete: operationalCounts,
    aiProposedPendingItemsToDelete: (pendingProposals ?? []).map((p) => ({ id: p.id, name: p.name })),
    masterCountsPreserved: masterCounts,
    vendorItemMappingsPreserved: mappings ?? [],
    documentStoragePathsToDelete: storagePaths,
    testOrgSnapshots,
  };
  mkdirSync("scripts/manifests", { recursive: true });
  const manifestPath = `scripts/manifests/reset-gansevoort-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nPre-reset manifest written: ${manifestPath}`);

  if (!execute) {
    console.log("\nREPORT-ONLY MODE -- nothing was deleted.");
    console.log("To execute: ALLOW_DEV_RESET=true npx tsx scripts/reset-gansevoort-dev-operational-data.ts --execute");
    return;
  }

  console.log("\nEXECUTING RESET ...");
  const { data: deleted, error: resetError } = await supabase.rpc("reset_dev_organization_operational_data", {
    p_organization_id: organizationId,
    p_confirmation: "RESET GANSEVOORT OPERATIONAL DATA",
  });
  if (resetError) {
    console.error(`Reset failed: ${resetError.message}`);
    process.exit(1);
  }
  console.log("Deleted (reported by the database):");
  console.log(JSON.stringify(deleted, null, 2));

  // Storage cleanup -- best-effort, after the DB reset succeeded.
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage.from("receiving-documents").remove(storagePaths);
    console.log(
      storageError
        ? `Storage cleanup warning: ${storageError.message} (rows are gone; orphaned files may remain)`
        : `Storage objects removed: ${storagePaths.length}`
    );
  }

  console.log("\n=== AFTER: operational counts (expect all 0) ===");
  for (const table of OPERATIONAL_TABLES) {
    console.log(`  ${table}: ${await countRows(supabase, table, organizationId)}`);
  }
  console.log("\n=== AFTER: master data (expect unchanged) ===");
  for (const table of MASTER_TABLES) {
    const after = await countRows(supabase, table, organizationId);
    const marker = table === "audit_events" || table === "inventory_items" ? "" : after === masterCounts[table] ? " ✓" : "  <-- CHANGED";
    console.log(`  ${table}: ${after}${marker}`);
  }
  console.log("  (audit_events may GROW by one DEV_OPERATIONAL_DATA_RESET event; inventory_items may shrink only by deleted AI-proposed PENDING_REVIEW orphans)");

  console.log("\n=== AFTER: TEST org snapshots (expect identical) ===");
  for (const org of testOrgs ?? []) {
    for (const table of ["documents", "purchase_documents", "receipts", "inventory_movements", "inventory_items", "vendors"]) {
      const before = testOrgSnapshots[`${org.name} (${org.id})`][table];
      const after = await countRows(supabase, table, org.id as string);
      console.log(`  ${org.name}.${table}: ${before} -> ${after}${before === after ? " ✓" : "  <-- CHANGED"}`);
    }
  }

  console.log("\nReset complete.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
