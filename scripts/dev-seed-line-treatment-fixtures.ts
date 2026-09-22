import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash, randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyExpectedProjectRef } from "./lib/verifyExpectedProjectRef";
import { findGansevoortOrgId } from "./lib/findGansevoortOrgId";
import { normalizeVendorName } from "@/app/lib/vendors/normalizeVendorName";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

// The RPC wrappers under app/lib are "server-only" modules (not loadable
// from a plain tsx script), so this script calls the same RPCs directly.
async function rpc<T>(sb: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, params);
  if (error) throw new Error(`${fn}: ${error.message} (${error.code ?? ""})`);
  return (Array.isArray(data) ? data[0] : data) as T;
}

/**
 * DEV-ONLY synthetic fixtures for the line-treatment classification UI
 * (Review Invoice / Items & Receiving / Review & Post). Creates, in the
 * GREEN DEV project's Gansevoort organization only:
 *   - one synthetic manager login ("TEST LT Manager") with manager + admin
 *     roles, password from LT_FIXTURE_MANAGER_PASSWORD or generated
 *     (printed once, never persisted here);
 *   - synthetic vendors, one synthetic tracked item stocked at Central
 *     Walk-In through an audited inventory correction;
 *   - twelve synthetic purchase documents (each with a tiny generated PDF
 *     in storage) whose lines carry pre-written AI/rule proposals through
 *     the SAME database writers the classifier uses -- no Gemini call, no
 *     real operational document is read or altered.
 * Every created record is prefixed "TEST LT". Guards: green project ref,
 * exactly one "Gansevoort" org, ALLOW_DEV_SEED=true, and --apply (dry run
 * by default). Idempotent for the login/vendors/item (find-or-create);
 * documents are created fresh on every --apply run (they are drafts a
 * manager can discard).
 */

const GREEN_REF = "dhjinzlxhzcrxujrorac";
const PREFIX = "TEST LT";
const APPLY = process.argv.includes("--apply");

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function buildPdf(title: string, lines: FixtureLine[], total: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text(`${PREFIX} SYNTHETIC INVOICE — ${title}`);
    doc.moveDown().fontSize(10).text("This is a synthetic test document generated for UI verification. Not a real invoice.");
    doc.moveDown();
    for (const l of lines) doc.text(`${l.sku ?? ""}  ${l.description}  ${l.qty ?? ""} ${l.unit ?? ""}  ${l.total.toFixed(2)}`);
    doc.moveDown().text(`TOTAL ${total.toFixed(2)}`);
    doc.end();
  });
}

interface FixtureLine {
  sku: string | null;
  description: string;
  qty: number | null;
  unit: string | null;
  unitPrice: number | null;
  total: number;
  ai:
    | { kind: "candidate"; confidence: number }
    | { kind: "treatment"; treatment: "EXPENSE" | "FREIGHT_FEE" | "TAX" | "DISCOUNT" | "CREDIT_RETURN" | "UNRESOLVED" | "INVENTORY_PURCHASE"; subtype?: "FINANCIAL_CREDIT" | "RETURNABLE_CONTAINER_CREDIT" | "INVENTORY_RETURN"; category?: string; scope?: "LINE" | "DOCUMENT"; confidence: number; reason: string; evidence: string[]; review?: string[] }
    | { kind: "none" };
}

interface Fixture {
  key: string;
  title: string;
  vendor: string;
  number: string;
  lines: FixtureLine[];
  tax?: number;
}

const FIXTURES: Fixture[] = [
  { key: "01-inventory", title: "Inventory purchase", vendor: "Bartlett Dairy", number: "BD-77821", lines: [
    { sku: "1842", description: "FARMLAND SOUR CREAM 10LB", qty: 2, unit: "PACK", unitPrice: 43, total: 86, ai: { kind: "candidate", confidence: 0.96 } },
  ] },
  { key: "02-repair", title: "Equipment repair expense", vendor: "Metro Refrigeration", number: "INV-7842", lines: [
    { sku: null, description: "WALK-IN COMPRESSOR REPAIR", qty: 1, unit: "SERVICE", unitPrice: 425, total: 425, ai: { kind: "treatment", treatment: "EXPENSE", category: "Repairs & Maintenance — Equipment", confidence: 0.97, reason: "This looks like a service or maintenance expense, not a product purchase.", evidence: ["keyword REPAIR", "vendor is a refrigeration service company"] } },
  ] },
  { key: "03-financial-credit", title: "Financial credit", vendor: "Bartlett Dairy", number: "BD-78401", lines: [
    { sku: null, description: "INVOICE CORRECTION - PRICE ADJ", qty: 1, unit: null, unitPrice: -15, total: -15, ai: { kind: "treatment", treatment: "CREDIT_RETURN", subtype: "FINANCIAL_CREDIT", confidence: 0.92, reason: "A vendor price correction credit; nothing physically moved.", evidence: ["negative amount", "keyword CORRECTION"] } },
  ] },
  { key: "04-container-credit", title: "Returnable-container credit", vendor: "Bartlett Dairy", number: "BD-78432", lines: [
    { sku: "99", description: "CASES RETURNED", qty: 1, unit: "case", unitPrice: -24, total: -24, ai: { kind: "treatment", treatment: "CREDIT_RETURN", subtype: "RETURNABLE_CONTAINER_CREDIT", confidence: 0.95, reason: "This appears to be a credit for returned containers, not a product purchase.", evidence: ["negative amount", "keyword RETURNED", "SKU 99 has no product description"] } },
  ] },
  { key: "05-inventory-return", title: "Tracked inventory return", vendor: "Bartlett Dairy", number: "BD-78455", lines: [
    { sku: "1842", description: "RETURNED 2 PACK FARMLAND SOUR CREAM 10LB - DAMAGED", qty: 2, unit: "PACK", unitPrice: -43, total: -86, ai: { kind: "treatment", treatment: "CREDIT_RETURN", subtype: "INVENTORY_RETURN", confidence: 0.9, reason: "Tracked merchandise was returned to the vendor.", evidence: ["negative amount", "keyword RETURNED", "matches stocked item"], review: ["quantity", "sourceLocation"] } },
  ] },
  { key: "06-discount", title: "Discount", vendor: "Fresh Foods Co.", number: "FF-88410", lines: [
    { sku: "PRD-1", description: "ROMAINE HEARTS 12CT", qty: 12, unit: "CASE", unitPrice: 6, total: 72, ai: { kind: "candidate", confidence: 0.98 } },
    { sku: null, description: "PROMOTIONAL DISCOUNT", qty: 1, unit: null, unitPrice: -10, total: -10, ai: { kind: "treatment", treatment: "DISCOUNT", scope: "DOCUMENT", confidence: 0.93, reason: "A promotional price reduction on the whole invoice.", evidence: ["keyword DISCOUNT", "negative amount"] } },
  ] },
  { key: "07-tax", title: "Sales tax", vendor: "Fresh Foods Co.", number: "884320", tax: 18.42, lines: [
    { sku: "PRD-2", description: "OLIVE OIL 3L", qty: 6, unit: "CASE", unitPrice: 12, total: 72, ai: { kind: "candidate", confidence: 0.96 } },
    { sku: null, description: "SALES TAX", qty: 1, unit: null, unitPrice: 18.42, total: 18.42, ai: { kind: "treatment", treatment: "TAX", confidence: 0.99, reason: "Sales tax line.", evidence: ["keyword SALES TAX"] } },
  ] },
  { key: "08-freight", title: "Freight / fuel surcharge", vendor: "Performance Foodservice", number: "INV-104328", lines: [
    { sku: null, description: "DELIVERY / FUEL SURCHARGE", qty: 1, unit: "EA", unitPrice: 35, total: 35, ai: { kind: "treatment", treatment: "FREIGHT_FEE", category: "Freight, Delivery & Fuel Surcharges", confidence: 0.98, reason: "A delivery/fuel surcharge added by the vendor.", evidence: ["keyword FUEL SURCHARGE"] } },
  ] },
  { key: "09-vendor-fee", title: "Vendor service fee", vendor: "Performance Foodservice", number: "INV-104402", lines: [
    { sku: null, description: "MINIMUM ORDER FEE", qty: 1, unit: "EA", unitPrice: 12, total: 12, ai: { kind: "treatment", treatment: "FREIGHT_FEE", category: "Vendor Fees & Service Charges", confidence: 0.94, reason: "A vendor minimum-order fee.", evidence: ["keyword MINIMUM ORDER FEE"] } },
  ] },
  { key: "10-unresolved", title: "Low-confidence unresolved line", vendor: "Metro Supply Co.", number: "78432", lines: [
    { sku: "MS-4", description: "MISC CHG / RTN 4", qty: 1, unit: null, unitPrice: -12.5, total: -12.5, ai: { kind: "treatment", treatment: "CREDIT_RETURN", confidence: 0.43, reason: "The abbreviation could be a miscellaneous charge or a return; the line does not say which.", evidence: ["negative amount", "ambiguous abbreviation"], review: ["treatment"] } },
  ] },
  { key: "11-mixed", title: "Mixed invoice", vendor: "Bartlett Dairy", number: "BD-79001", tax: 6.12, lines: [
    { sku: "1842", description: "FARMLAND SOUR CREAM 10LB", qty: 3, unit: "PACK", unitPrice: 43, total: 129, ai: { kind: "candidate", confidence: 0.96 } },
    { sku: null, description: "WALK-IN COMPRESSOR REPAIR", qty: 1, unit: "SERVICE", unitPrice: 425, total: 425, ai: { kind: "treatment", treatment: "EXPENSE", category: "Repairs & Maintenance — Equipment", confidence: 0.97, reason: "Service/repair, not a product purchase.", evidence: ["keyword REPAIR"] } },
    { sku: "99", description: "CASES RETURNED", qty: 1, unit: "case", unitPrice: -24, total: -24, ai: { kind: "treatment", treatment: "CREDIT_RETURN", subtype: "RETURNABLE_CONTAINER_CREDIT", confidence: 0.95, reason: "Returned containers credit.", evidence: ["negative amount", "keyword RETURNED"] } },
    { sku: null, description: "FUEL SURCHARGE", qty: 1, unit: null, unitPrice: 8.5, total: 8.5, ai: { kind: "treatment", treatment: "FREIGHT_FEE", category: "Freight, Delivery & Fuel Surcharges", confidence: 0.98, reason: "Fuel surcharge.", evidence: ["keyword FUEL SURCHARGE"] } },
    { sku: null, description: "SALES TAX", qty: 1, unit: null, unitPrice: 6.12, total: 6.12, ai: { kind: "treatment", treatment: "TAX", confidence: 0.99, reason: "Sales tax line.", evidence: ["keyword SALES TAX"] } },
  ] },
  { key: "12-expense-only", title: "Expense-only invoice", vendor: "Metro Refrigeration", number: "INV-7901", lines: [
    { sku: null, description: "WALK-IN COMPRESSOR REPAIR", qty: 1, unit: "SERVICE", unitPrice: 425, total: 425, ai: { kind: "treatment", treatment: "EXPENSE", category: "Repairs & Maintenance — Equipment", confidence: 0.97, reason: "Service/repair, not a product purchase.", evidence: ["keyword REPAIR"] } },
    { sku: null, description: "QUARTERLY PEST CONTROL VISIT", qty: 1, unit: "SERVICE", unitPrice: 150, total: 150, ai: { kind: "treatment", treatment: "EXPENSE", category: "Pest Control", confidence: 0.85, reason: "A pest-control service visit.", evidence: ["keyword PEST CONTROL"], review: ["spendCategoryId"] } },
  ] },
];

async function findOrCreateVendor(sb: SupabaseClient, org: string, name: string, classification: "INVENTORY" | "NON_INVENTORY"): Promise<string> {
  const full = `${PREFIX} ${name}`;
  const { data: existing } = await sb.from("vendors").select("id").eq("organization_id", org).eq("normalized_name", normalizeVendorName(full)).maybeSingle();
  if (existing) return existing.id as string;
  const { data, error } = await sb.from("vendors").insert({ organization_id: org, name: full, normalized_name: normalizeVendorName(full), is_active: true, classification }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function main() {
  if (process.env.ALLOW_DEV_SEED !== "true") {
    console.error("Refusing to run: set ALLOW_DEV_SEED=true");
    process.exit(1);
  }
  const url = must("SUPABASE_URL");
  const key = must("SUPABASE_SECRET_KEY");
  const pepper = must("PIN_PEPPER");
  if (!url.includes(GREEN_REF)) {
    console.error(`ABORT: SUPABASE_URL is not the green DEV project (${GREEN_REF})`);
    process.exit(1);
  }
  verifyExpectedProjectRef(url);
  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const org = await findGansevoortOrgId(sb);
  console.log(`Organization: ${org}`);

  const { data: location } = await sb.from("locations").select("id, name").eq("organization_id", org).eq("is_active", true).eq("is_storage_eligible", true);
  if (!location || location.length !== 1) {
    console.error("Expected exactly one active storage-eligible location (Central Walk-In).");
    process.exit(1);
  }
  const locationId = location[0].id as string;
  console.log(`Location: ${location[0].name}`);

  const { data: cats } = await sb.from("spend_categories").select("id, name").eq("organization_id", org).eq("is_active", true);
  const categoryIdByName = new Map((cats ?? []).map((c) => [c.name as string, c.id as string]));
  const { data: units } = await sb.from("units").select("id, code");
  const unitIdByCode = new Map((units ?? []).map((u) => [u.code as string, u.id as string]));
  const { data: dairy } = await sb.from("inventory_categories").select("id").eq("organization_id", org).eq("is_active", true).ilike("name", "Dairy%").limit(1).maybeSingle();

  console.log(APPLY ? "APPLY mode" : "DRY RUN (pass --apply to create fixtures)");
  console.log(`Would create: 1 manager login, ${new Set(FIXTURES.map((f) => f.vendor)).size} vendors, 1 item, ${FIXTURES.length} documents`);
  if (!APPLY) return;

  // ---- 1. manager login --------------------------------------------------
  const email = process.env.LT_FIXTURE_MANAGER_EMAIL ?? "test-lt-manager@example.test";
  const password = process.env.LT_FIXTURE_MANAGER_PASSWORD ?? `Lt-${randomUUID().slice(0, 12)}!`;
  let authUserId: string;
  const created = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) {
    authUserId = created.data.user.id;
    console.log(`Created auth user ${email} with password: ${password}  (save it now; not persisted)`);
  } else {
    const list = await sb.auth.admin.listUsers();
    const existing = list.data.users.find((u) => u.email === email);
    if (!existing) throw created.error ?? new Error("could not create auth user");
    authUserId = existing.id;
    await sb.auth.admin.updateUserById(authUserId, { password });
    console.log(`Reusing auth user ${email}; password reset to: ${password}  (save it now; not persisted)`);
  }
  let { data: employee } = await sb.from("employees").select("id").eq("organization_id", org).eq("employee_code", "TEST-LT-MGR").maybeSingle();
  if (!employee) {
    const ins = await sb.from("employees").insert({ organization_id: org, first_name: "Test LT", last_name: "Manager", employee_code: "TEST-LT-MGR", default_station_id: null, auto_resolve_station: false, can_change_station: false, status: "active" }).select("id").single();
    if (ins.error) throw ins.error;
    employee = ins.data;
  }
  let { data: appUser } = await sb.from("app_users").select("id").eq("employee_id", employee!.id as string).maybeSingle();
  if (!appUser) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const ins = await sb.from("app_users").insert({ organization_id: org, employee_id: employee!.id, auth_user_id: authUserId, pin_lookup_hash: hashPinLookup(pin, pepper), pin_hash: await hashPinForStorage(pin) }).select("id").single();
    if (ins.error) throw ins.error;
    appUser = ins.data;
  } else {
    await sb.from("app_users").update({ auth_user_id: authUserId }).eq("id", appUser.id as string);
  }
  const appUserId = appUser!.id as string;
  const { data: roles } = await sb.from("roles").select("id, name").in("name", ["manager", "admin"]);
  for (const role of roles ?? []) {
    await sb.from("user_roles").upsert({ app_user_id: appUserId, role_id: role.id as string, organization_id: org }, { onConflict: "app_user_id,role_id" });
  }
  console.log(`Manager app_user: ${appUserId}`);

  // ---- 2. vendors ---------------------------------------------------------
  const vendorIdByName = new Map<string, string>();
  for (const name of new Set(FIXTURES.map((f) => f.vendor))) {
    vendorIdByName.set(name, await findOrCreateVendor(sb, org, name, name === "Metro Refrigeration" || name === "Metro Supply Co." ? "NON_INVENTORY" : "INVENTORY"));
  }

  // ---- 3. synthetic tracked item, stocked at Central Walk-In --------------
  const itemName = `${PREFIX} Sour Cream`;
  let { data: item } = await sb.from("inventory_items").select("id").eq("organization_id", org).ilike("name", itemName).maybeSingle();
  if (!item) {
    const ins = await sb.from("inventory_items").insert({ organization_id: org, category_id: dairy?.id ?? null, name: itemName, base_unit_id: unitIdByCode.get("LB"), status: "active", disposition: "INVENTORY", approval_status: "CONFIRMED", created_via: "MANUAL" }).select("id").single();
    if (ins.error) throw ins.error;
    item = ins.data;
    await sb.from("inventory_item_units").insert([
      { inventory_item_id: item.id, unit_id: unitIdByCode.get("LB"), conversion_factor: 1, requires_actual_measurement: false, is_default_entry_unit: true, is_active: true },
      { inventory_item_id: item.id, unit_id: unitIdByCode.get("PACK"), conversion_factor: 10, requires_actual_measurement: false, is_default_entry_unit: false, is_active: true },
    ]);
  }
  const itemId = item!.id as string;
  const { data: balance } = await sb.rpc("inventory_location_item_balance", { p_organization_id: org, p_inventory_item_id: itemId, p_location_id: locationId });
  if (Number(balance ?? 0) < 50) {
    const { error } = await sb.rpc("record_inventory_correction", { p_app_user_id: appUserId, p_inventory_item_id: itemId, p_location_id: locationId, p_mode: "DELTA", p_counted_quantity: null, p_delta_quantity: 50, p_reason: `${PREFIX} synthetic opening stock`, p_client_request_id: randomUUID() });
    if (error) throw error;
  }
  console.log(`Item: ${itemName} (${itemId})`);

  // ---- 4. documents ---------------------------------------------------------
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  for (const fixture of FIXTURES) {
    const vendorId = vendorIdByName.get(fixture.vendor)!;
    const total = fixture.lines.reduce((s, l) => s + l.total, 0) + (fixture.tax && !fixture.lines.some((l) => l.description === "SALES TAX") ? fixture.tax : 0);
    const documentId = randomUUID();
    const pdf = await buildPdf(fixture.title, fixture.lines, total);
    const storagePath = `org/${org}/documents/${documentId}/original.pdf`;
    const up = await sb.storage.from(RECEIVING_DOCUMENTS_BUCKET).upload(storagePath, pdf, { contentType: "application/pdf", upsert: true });
    if (up.error) throw up.error;
    const finalized = await rpc<{ out_attempt_id: string }>(sb, "finalize_document_upload", {
      p_document_id: documentId,
      p_organization_id: org,
      p_uploaded_by_app_user_id: appUserId,
      p_storage_path: storagePath,
      p_original_filename: `${PREFIX} ${fixture.key}.pdf`,
      p_content_type: "application/pdf",
      p_byte_size: pdf.byteLength,
      p_file_sha256: createHash("sha256").update(pdf).digest("hex"),
      p_provider: "gemini",
      p_model: "synthetic-fixture",
      p_vendor_id: vendorId,
      p_declared_document_type: "INVOICE",
    });
    const attemptId = finalized.out_attempt_id;
    await sb.from("document_extractions").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", attemptId);
    const { error: extErr } = await sb
      .from("document_extractions")
      .update({
        status: "SUCCEEDED",
        completed_at: new Date().toISOString(),
        normalized_extraction: {
          documentType: "INVOICE",
          vendorName: `${PREFIX} ${fixture.vendor}`,
          invoiceNumber: `${fixture.number}-${randomUUID().slice(0, 4).toUpperCase()}`,
          invoiceDate: iso(today),
          deliveryDate: iso(today),
          subtotal: Math.round((total - (fixture.tax ?? 0)) * 100) / 100,
          tax: fixture.tax ?? null,
          fees: null,
          total: Math.round(total * 100) / 100,
          currency: "USD",
          lines: fixture.lines.map((l) => ({ vendorSku: l.sku, description: l.description, packageQuantity: l.qty, packageUnit: l.unit, measuredQuantity: null, measuredUnit: null, unitPrice: l.unitPrice, priceBasisUnit: l.unit, lineTotal: l.total, rawLineText: null })),
          warnings: [],
        },
        review_flags: [],
      })
      .eq("id", attemptId);
    if (extErr) throw extErr;
    const draftRow = await rpc<{ out_purchase_document_id: string }>(sb, "initialize_purchase_document_draft", { p_document_id: documentId, p_organization_id: org, p_app_user_id: appUserId });
    const draft = { purchaseDocumentId: draftRow.out_purchase_document_id };
    const { data: lineRows } = await sb.from("purchase_document_lines").select("line_key, line_number").eq("purchase_document_id", draft.purchaseDocumentId).order("line_number");
    for (let i = 0; i < fixture.lines.length; i++) {
      const line = fixture.lines[i];
      const lineKey = (lineRows ?? [])[i]?.line_key as string;
      if (line.ai.kind === "candidate") {
        await rpc(sb, "record_ai_suggested_candidate", { p_organization_id: org, p_purchase_document_id: draft.purchaseDocumentId, p_line_key: lineKey, p_candidate_inventory_item_id: itemId, p_ai_confidence: line.ai.confidence });
      } else if (line.ai.kind === "treatment") {
        await rpc(sb, "record_ai_line_treatment", {
          p_organization_id: org,
          p_purchase_document_id: draft.purchaseDocumentId,
          p_line_key: lineKey,
          p_proposed_treatment: line.ai.treatment,
          p_proposed_credit_subtype: line.ai.subtype ?? null,
          p_proposed_spend_category_id: line.ai.category ? (categoryIdByName.get(line.ai.category) ?? null) : null,
          p_ai_confidence: line.ai.confidence,
          p_ai_reason: line.ai.reason,
          p_ai_evidence: line.ai.evidence,
          p_ai_review_fields: line.ai.review ?? [],
          p_resolution_source: "AI_SUGGESTED",
          p_treatment_rule_id: null,
          p_discount_scope: line.ai.scope ?? null,
        });
      }
    }
    console.log(`${fixture.key}: /manager/purchases/${draft.purchaseDocumentId}?step=invoice  (${fixture.title})`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
