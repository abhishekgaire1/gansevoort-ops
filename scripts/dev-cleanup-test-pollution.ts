import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";

/**
 * ONE-TIME, DEV-ONLY cleanup of automated-integration-test rows that landed
 * in the real "Gansevoort" organization before tests/testFixtures.ts was
 * fixed to use a dedicated "TEST RPC Fixture Org" instead. NOT a migration
 * -- migrations apply identically to every environment forever, and this is
 * a one-off correction for pre-existing DEV pollution, not a schema change.
 *
 * DEFAULT BEHAVIOR IS DRY RUN: this script only ever reads data and prints
 * a report unless invoked with --execute. Even with --execute, it still
 * requires an interactive "yes" confirmation (or --yes to skip that,
 * mirroring dev-seed.ts) before touching anything.
 *
 * CANDIDATE IDENTIFICATION uses two independent signals for documents (the
 * table everything else cascades from), never a filename pattern alone:
 *   1. original_filename matches a known synthetic pattern (filler-%.pdf,
 *      test.pdf, test-invoice.pdf, queue-target.pdf) -- see
 *      tests/purchaseDocuments.rpc.test.ts / finalizeDocumentUploadRpc.rpc.
 *      test.ts / receivingQueue.rpc.test.ts for where these come from.
 *   2. uploaded_by_app_user_id belongs to an employee whose employee_code
 *      starts with "TEST-" (never "DEV-", which is reserved for real
 *      dev-seed.ts-created managers/employees -- see scripts/dev-seed.ts).
 * Both must match. Vendors/employees/app_users are only ever candidates if,
 * in addition to their own naming signal ("TEST-" employee_code prefix, or
 * a "TEST RPC Fixture" vendor name), they have ZERO remaining references
 * anywhere (including inventory_movements
 * and audit_events, which this script never touches) after the planned
 * document-family deletion -- so a fixture employee/app_user who ALSO
 * performed a real inventory withdrawal during testing stays, permanently,
 * exactly as it must (inventory_movements/audit_events are append-only).
 *
 * SCOPE (deliberately excludes, per the approved cleanup plan):
 *   inventory_movements, inventory_movement_lines, audit_events -- these
 *   are never visible on /manager/receiving or /manager/vendors (the
 *   screens this cleanup exists for), are append-only by design, and
 *   touching them is disproportionate risk for zero visible benefit.
 *   stations/inventory_items/inventory_item_units/inventory_categories/
 *   control_rules -- same append-only-reference problem (inventory_movements
 *   pins them) and, unlike documents/vendors, invisible on the two screens
 *   this cleanup targets; left alone entirely.
 *
 * IMMUTABILITY: documents/document_extractions/purchase_documents/
 * purchase_document_lines are intentionally guarded by triggers (forbid_
 * update_delete / purchase_documents_forbid_locked_mutation / purchase_
 * document_lines_forbid_when_locked). --execute suspends ONLY those exact
 * triggers, ONLY inside one explicit transaction built as a single SQL
 * script and executed via `supabase db query --linked` (supabase-js/
 * PostgREST has no way to run a real multi-statement transaction), re-
 * enables them before COMMIT, and relies on Postgres rolling back the
 * entire transaction automatically if any statement in it fails -- the
 * triggers are never left disabled under any outcome.
 */

interface Candidates {
  documentIds: string[];
  documentSummaries: { id: string; original_filename: string; created_at: string }[];
  extractionIds: string[];
  purchaseDocumentIds: string[];
  purchaseDocumentLineIds: string[];
  vendorIds: string[];
  vendorSummaries: { id: string; name: string }[];
  appUserIds: string[];
  employeeIds: string[];
  employeeSummaries: { id: string; employee_code: string; first_name: string; last_name: string }[];
  protectedDocumentSummaries: { id: string; original_filename: string; reason: string }[];
  protectedVendorSummaries: { id: string; name: string; reason: string }[];
  protectedEmployeeSummaries: { id: string; employee_code: string; reason: string }[];
}

const SYNTHETIC_FILENAME_EXACT = ["test.pdf", "test-invoice.pdf", "queue-target.pdf"];
/** SQL-equivalent: original_filename ilike 'filler-%.pdf'. */
const SYNTHETIC_FILLER_FILENAME_REGEX = /^filler-.*\.pdf$/i;

function verifyExpectedProjectRefOrExit(supabaseUrl: string): void {
  verifyExpectedProjectRef(supabaseUrl);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function confirm(message: string): Promise<void> {
  if (process.argv.includes("--yes")) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} Type "yes" to continue: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("Aborted.");
    process.exit(1);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Defense in depth: every id used to build the deletion SQL is verified to
 * be a well-formed UUID (they all come from our own prior SELECTs against
 * this same database, never from external/user input, but this makes an
 * injected/malformed value structurally impossible to reach the SQL text
 * regardless). */
function sqlUuidArray(ids: string[]): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`Refusing to build SQL: "${id}" is not a well-formed UUID.`);
  }
  if (ids.length === 0) return "array[]::uuid[]";
  return `array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`;
}

async function findCandidates(supabase: SupabaseClient, organizationId: string): Promise<Candidates> {
  // Signal 2: employees marked as automated-test fixtures by naming
  // convention (never "DEV-*", which is reserved for real seeded managers).
  // Every fetch below is scoped by organization_id (Gansevoort's total row
  // counts are in the hundreds, not thousands) and matching against
  // candidate id sets happens in JS with Set/Map lookups -- deliberately
  // NOT via PostgREST .in()/.not(...,'in',...) with hundreds of UUIDs
  // interpolated into the request, which is exactly what blew past
  // PostgREST's URL-length limit (a real "Bad Request" hit while building
  // this script, not a hypothetical concern) once the actual candidate
  // count turned out to be in the 700s.
  const { data: testEmployeesRaw, error: employeesError } = await supabase
    .from("employees")
    .select("id, employee_code, first_name, last_name")
    .eq("organization_id", organizationId)
    .ilike("employee_code", "TEST-%");
  if (employeesError) throw employeesError;
  const testEmployees = testEmployeesRaw ?? [];

  const { data: allAppUsersRaw, error: appUsersError } = await supabase
    .from("app_users")
    .select("id, employee_id")
    .eq("organization_id", organizationId);
  if (appUsersError) throw appUsersError;
  const appUserByEmployeeId = new Map((allAppUsersRaw ?? []).map((u) => [u.employee_id as string, u.id as string]));
  const testAppUserIds = new Set(
    testEmployees.map((e) => appUserByEmployeeId.get(e.id as string)).filter((id): id is string => Boolean(id))
  );

  // Signal 1 + intersection with signal 2: known synthetic filename
  // patterns, uploaded by one of the TEST-* app_users above.
  const { data: allDocumentsRaw, error: docsError } = await supabase
    .from("documents")
    .select("id, original_filename, uploaded_by_app_user_id, vendor_id, created_at")
    .eq("organization_id", organizationId);
  if (docsError) throw docsError;
  const allDocuments = allDocumentsRaw ?? [];

  const filenameMatches = allDocuments.filter(
    (d) => SYNTHETIC_FILLER_FILENAME_REGEX.test(d.original_filename as string) || SYNTHETIC_FILENAME_EXACT.includes(d.original_filename as string)
  );

  const candidateDocuments = filenameMatches.filter((d) => testAppUserIds.has(d.uploaded_by_app_user_id as string));
  const documentIds = candidateDocuments.map((d) => d.id as string);
  const documentIdSet = new Set(documentIds);
  const documentSummaries = candidateDocuments.map((d) => ({
    id: d.id as string,
    original_filename: d.original_filename as string,
    created_at: d.created_at as string,
  }));

  // Filename matched but the uploader is NOT a TEST-* employee -- protected,
  // explicitly surfaced so it's obvious why it was excluded.
  const protectedDocumentSummaries = filenameMatches
    .filter((d) => !testAppUserIds.has(d.uploaded_by_app_user_id as string))
    .map((d) => ({
      id: d.id as string,
      original_filename: d.original_filename as string,
      reason: "filename matched a synthetic pattern, but the uploader is not a TEST-* fixture employee",
    }));

  const { data: allExtractionsRaw, error: extractionsError } = await supabase
    .from("document_extractions")
    .select("id, document_id")
    .eq("organization_id", organizationId);
  if (extractionsError) throw extractionsError;
  const extractionIds = (allExtractionsRaw ?? []).filter((e) => documentIdSet.has(e.document_id as string)).map((e) => e.id as string);

  const { data: allPurchaseDocumentsRaw, error: pdError } = await supabase
    .from("purchase_documents")
    .select("id, source_document_id, vendor_id, created_by_app_user_id, verified_by_app_user_id, last_returned_by_app_user_id")
    .eq("organization_id", organizationId);
  if (pdError) throw pdError;
  const allPurchaseDocuments = allPurchaseDocumentsRaw ?? [];
  const candidatePurchaseDocuments = allPurchaseDocuments.filter((pd) => documentIdSet.has(pd.source_document_id as string));
  const purchaseDocumentIds = candidatePurchaseDocuments.map((pd) => pd.id as string);
  const purchaseDocumentIdSet = new Set(purchaseDocumentIds);

  const { data: allLinesRaw, error: linesError } = await supabase
    .from("purchase_document_lines")
    .select("id, purchase_document_id")
    .eq("organization_id", organizationId);
  if (linesError) throw linesError;
  const purchaseDocumentLineIds = (allLinesRaw ?? [])
    .filter((l) => purchaseDocumentIdSet.has(l.purchase_document_id as string))
    .map((l) => l.id as string);

  // Vendors: named like a fixture AND not referenced by any document/
  // purchase_document that ISN'T itself a candidate for deletion.
  const { data: fixtureVendorsRaw, error: vendorsError } = await supabase
    .from("vendors")
    .select("id, name")
    .eq("organization_id", organizationId)
    .ilike("name", "TEST RPC Fixture%");
  if (vendorsError) throw vendorsError;
  const fixtureVendors = fixtureVendorsRaw ?? [];

  const vendorIds: string[] = [];
  const vendorSummaries: { id: string; name: string }[] = [];
  const protectedVendorSummaries: { id: string; name: string; reason: string }[] = [];
  for (const vendor of fixtureVendors) {
    const vendorId = vendor.id as string;
    const docRefs = allDocuments.filter((d) => d.vendor_id === vendorId && !documentIdSet.has(d.id as string)).length;
    const pdRefs = allPurchaseDocuments.filter((pd) => pd.vendor_id === vendorId && !purchaseDocumentIdSet.has(pd.id as string)).length;
    if (docRefs === 0 && pdRefs === 0) {
      vendorIds.push(vendorId);
      vendorSummaries.push({ id: vendorId, name: vendor.name as string });
    } else {
      protectedVendorSummaries.push({
        id: vendorId,
        name: vendor.name as string,
        reason: `still referenced by ${docRefs} document(s) and ${pdRefs} purchase_document(s) outside the candidate set`,
      });
    }
  }

  // Employees/app_users: TEST-* naming AND zero remaining references
  // anywhere, including tables this script never touches (inventory_
  // movements, audit_events) -- an employee who also performed a real
  // withdrawal during testing must remain, permanently.
  const { data: allMovementsRaw, error: movementsError } = await supabase
    .from("inventory_movements")
    .select("id, performed_by_app_user_id")
    .eq("organization_id", organizationId);
  if (movementsError) throw movementsError;
  const allMovements = allMovementsRaw ?? [];

  const { data: allAuditEventsRaw, error: auditError } = await supabase
    .from("audit_events")
    .select("id, actor_app_user_id")
    .eq("organization_id", organizationId);
  if (auditError) throw auditError;
  const allAuditEvents = allAuditEventsRaw ?? [];

  const appUserIds: string[] = [];
  const employeeIds: string[] = [];
  const employeeSummaries: Candidates["employeeSummaries"] = [];
  const protectedEmployeeSummaries: Candidates["protectedEmployeeSummaries"] = [];

  for (const employee of testEmployees) {
    const employeeId = employee.id as string;
    const appUserId = appUserByEmployeeId.get(employeeId);

    const reasons: string[] = [];
    if (appUserId) {
      const uploadedRefs = allDocuments.filter(
        (d) => d.uploaded_by_app_user_id === appUserId && !documentIdSet.has(d.id as string)
      ).length;
      if (uploadedRefs > 0) reasons.push(`uploaded ${uploadedRefs} document(s) outside the candidate set`);

      for (const col of ["created_by_app_user_id", "verified_by_app_user_id", "last_returned_by_app_user_id"] as const) {
        const refs = allPurchaseDocuments.filter((pd) => pd[col] === appUserId && !purchaseDocumentIdSet.has(pd.id as string)).length;
        if (refs > 0) reasons.push(`referenced as ${col} on ${refs} purchase_document(s) outside the candidate set`);
      }

      const movementRefs = allMovements.filter((m) => m.performed_by_app_user_id === appUserId).length;
      if (movementRefs > 0) reasons.push(`performed ${movementRefs} inventory_movements (append-only, never cleaned up)`);

      const auditRefs = allAuditEvents.filter((a) => a.actor_app_user_id === appUserId).length;
      if (auditRefs > 0) reasons.push(`is the actor on ${auditRefs} audit_events (append-only, never cleaned up)`);
    }

    if (reasons.length === 0) {
      employeeIds.push(employeeId);
      employeeSummaries.push({
        id: employeeId,
        employee_code: employee.employee_code as string,
        first_name: employee.first_name as string,
        last_name: employee.last_name as string,
      });
      if (appUserId) appUserIds.push(appUserId);
    } else {
      protectedEmployeeSummaries.push({ id: employeeId, employee_code: employee.employee_code as string, reason: reasons.join("; ") });
    }
  }

  return {
    documentIds,
    documentSummaries,
    extractionIds,
    purchaseDocumentIds,
    purchaseDocumentLineIds,
    vendorIds,
    vendorSummaries,
    appUserIds,
    employeeIds,
    employeeSummaries,
    protectedDocumentSummaries,
    protectedVendorSummaries,
    protectedEmployeeSummaries,
  };
}

function printList<T>(label: string, items: T[], render: (item: T) => string, max = 25): void {
  console.log(`\n${label}: ${items.length}`);
  for (const item of items.slice(0, max)) {
    console.log(`  - ${render(item)}`);
  }
  if (items.length > max) {
    console.log(`  ...and ${items.length - max} more`);
  }
}

function buildCleanupSql(c: Candidates): string {
  return `
begin;

alter table public.documents disable trigger documents_forbid_update;
alter table public.documents disable trigger documents_forbid_delete;
alter table public.document_extractions disable trigger document_extractions_forbid_delete;
alter table public.purchase_documents disable trigger purchase_documents_forbid_locked_update;
alter table public.purchase_documents disable trigger purchase_documents_forbid_locked_delete;
alter table public.purchase_document_lines disable trigger purchase_document_lines_forbid_when_locked;

delete from public.purchase_document_lines where id = any(${sqlUuidArray(c.purchaseDocumentLineIds)});
delete from public.purchase_documents where id = any(${sqlUuidArray(c.purchaseDocumentIds)});
delete from public.document_extractions where id = any(${sqlUuidArray(c.extractionIds)});
delete from public.documents where id = any(${sqlUuidArray(c.documentIds)});
delete from public.vendors where id = any(${sqlUuidArray(c.vendorIds)});
delete from public.app_users where id = any(${sqlUuidArray(c.appUserIds)});
delete from public.employees where id = any(${sqlUuidArray(c.employeeIds)});

alter table public.purchase_document_lines enable trigger purchase_document_lines_forbid_when_locked;
alter table public.purchase_documents enable trigger purchase_documents_forbid_locked_delete;
alter table public.purchase_documents enable trigger purchase_documents_forbid_locked_update;
alter table public.document_extractions enable trigger document_extractions_forbid_delete;
alter table public.documents enable trigger documents_forbid_delete;
alter table public.documents enable trigger documents_forbid_update;

commit;
`.trim();
}

async function main(): Promise<void> {
  if (process.env.ALLOW_DEV_SEED !== "true") {
    console.error("ALLOW_DEV_SEED=true is required to run this script (same gate as scripts/dev-seed.ts).");
    process.exit(1);
  }

  const execute = process.argv.includes("--execute");

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");

  verifyExpectedProjectRefOrExit(supabaseUrl);
  console.log(`Connected to: ${supabaseUrl}`);
  console.log(execute ? "MODE: --execute (will delete matching rows after confirmation)" : "MODE: dry run / preview (no changes will be made)");

  const supabase = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const organizationId = await findGansevoortOrgId(supabase);
  console.log(`Gansevoort organization: ${organizationId}`);

  console.log("\nIdentifying candidates (read-only)...");
  const candidates = await findCandidates(supabase, organizationId);

  console.log("\n================ CLEANUP CANDIDATES ================");
  printList("purchase_document_lines", candidates.purchaseDocumentLineIds, (id) => id);
  printList("purchase_documents", candidates.purchaseDocumentIds, (id) => id);
  printList("document_extractions", candidates.extractionIds, (id) => id);
  printList("documents", candidates.documentSummaries, (d) => `${d.id}  ${d.original_filename}  (${d.created_at})`);
  printList("vendors", candidates.vendorSummaries, (v) => `${v.id}  "${v.name}"`);
  printList("employees (and their app_users)", candidates.employeeSummaries, (e) => `${e.id}  ${e.employee_code}  ${e.first_name} ${e.last_name}`);

  console.log("\n================ PROTECTED (excluded, will NOT be touched) ================");
  printList("documents", candidates.protectedDocumentSummaries, (d) => `${d.id}  ${d.original_filename}  -- ${d.reason}`);
  printList("vendors", candidates.protectedVendorSummaries, (v) => `${v.id}  "${v.name}"  -- ${v.reason}`);
  printList("employees", candidates.protectedEmployeeSummaries, (e) => `${e.id}  ${e.employee_code}  -- ${e.reason}`);

  console.log(
    "\nNEVER touched by this script regardless of mode: inventory_movements, inventory_movement_lines, audit_events, " +
      "stations, inventory_items, inventory_item_units, inventory_categories, control_rules (see the module comment for why)."
  );

  if (!execute) {
    console.log("\nDRY RUN complete -- zero database changes made. Re-run with --execute to actually delete the rows above.");
    return;
  }

  if (candidates.documentIds.length === 0) {
    console.log("\nNo candidate documents found -- nothing to execute.");
    return;
  }

  await confirm(
    `\nAbout to PERMANENTLY DELETE ${candidates.documentIds.length} documents (and their extractions/purchase_documents/lines), ` +
      `${candidates.vendorIds.length} vendors, and ${candidates.employeeIds.length} employees/app_users from Gansevoort at ${supabaseUrl}.`
  );

  const sql = buildCleanupSql(candidates);
  const tempFile = `/tmp/dev-cleanup-test-pollution-${randomUUID()}.sql`;
  writeFileSync(tempFile, sql, "utf8");
  try {
    console.log("\nExecuting cleanup transaction via `supabase db query --linked`...");
    const output = execFileSync("npx", ["supabase", "db", "query", "--linked", "--file", tempFile], { encoding: "utf8" });
    console.log(output);
    console.log("Cleanup transaction committed.");
  } finally {
    unlinkSync(tempFile);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
