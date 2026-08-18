import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { finalizeDocumentUploadRpc } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * Shared helper for the 2A.3 .rpc.test.ts files -- creates a real,
 * SUCCEEDED-extraction-backed purchase_document DRAFT with at least one
 * line, the minimum any item-classification/receiving RPC needs to attach
 * to (none of them require any particular purchase_document status).
 * Mirrors createSucceededDocument in purchaseDocuments.rpc.test.ts.
 */
export async function createDraftPurchaseDocumentWithLines(
  supabase: SupabaseClient,
  opts: {
    organizationId: string;
    vendorId: string;
    uploadedByAppUserId: string;
    lines?: { vendorSku?: string | null; description?: string | null; packageUnit?: string | null; measuredUnit?: string | null; packageQuantity?: number }[];
  }
): Promise<{ purchaseDocumentId: string; documentId: string }> {
  const documentId = randomUUID();
  const lines = opts.lines ?? [{ vendorSku: "SKU-1", description: "Test Line Item", packageUnit: "CS", measuredUnit: "LB" }];

  const finalizeResult = await finalizeDocumentUploadRpc(supabase, {
    documentId,
    organizationId: opts.organizationId,
    uploadedByAppUserId: opts.uploadedByAppUserId,
    storagePath: `org/${opts.organizationId}/documents/${documentId}/original.pdf`,
    originalFilename: "test.pdf",
    contentType: "application/pdf",
    byteSize: 1000,
    fileSha256: randomBytes(32).toString("hex"),
    provider: "gemini",
    model: "gemini-3.6-flash",
    vendorId: opts.vendorId,
    declaredDocumentType: "INVOICE",
  });

  await supabase.from("document_extractions").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", finalizeResult.attemptId);
  const { error } = await supabase
    .from("document_extractions")
    .update({
      status: "SUCCEEDED",
      completed_at: new Date().toISOString(),
      normalized_extraction: {
        documentType: "INVOICE",
        vendorName: "Test Vendor",
        invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
        invoiceDate: "2026-08-12",
        subtotal: 100,
        tax: 0,
        fees: 0,
        total: 100,
        currency: "USD",
        lines: lines.map((l) => ({
          vendorSku: l.vendorSku ?? null,
          description: l.description ?? null,
          packageQuantity: l.packageQuantity ?? 1,
          packageUnit: l.packageUnit ?? null,
          measuredQuantity: 1,
          measuredUnit: l.measuredUnit ?? null,
          unitPrice: 100,
          priceBasisUnit: l.measuredUnit ?? null,
          lineTotal: 100,
        })),
        warnings: [],
      },
      review_flags: [],
    })
    .eq("id", finalizeResult.attemptId);
  if (error) throw error;

  const draft = await initializePurchaseDocumentDraftRpc(supabase, {
    documentId,
    organizationId: opts.organizationId,
    appUserId: opts.uploadedByAppUserId,
  });

  return { purchaseDocumentId: draft.purchaseDocumentId, documentId };
}

export async function getLineKeys(supabase: SupabaseClient, purchaseDocumentId: string): Promise<string[]> {
  const { data, error } = await supabase.from("purchase_document_lines").select("line_key").eq("purchase_document_id", purchaseDocumentId).order("line_number");
  // Fail loudly: a swallowed error here returns [], and the caller's
  // destructured undefined lineKey then surfaces as a baffling
  // "function not found in schema cache" PostgREST error (supabase-js
  // strips undefined params) far from the real cause.
  if (error) throw new Error(`getLineKeys failed: ${error.message}`);
  return (data ?? []).map((r) => r.line_key as string);
}

/**
 * A dedicated, stably-named employee for tests that need a real
 * employee id but must NOT reuse fx.changeableEmployeeAppUserId's own
 * employee -- that one is explicitly "changeable" because OTHER
 * concurrently-running test files intentionally mutate its PIN/state,
 * which caused exactly this session's earlier flaky-fixture lesson.
 * Delivery-verifier tests need an employee nobody else touches.
 */
export async function findOrCreateNamedEmployee(supabase: SupabaseClient, organizationId: string, name: string): Promise<string> {
  const { data: existing } = await supabase.from("employees").select("id").eq("organization_id", organizationId).eq("first_name", name).eq("last_name", "TestFixture").maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from("employees")
    .insert({ organization_id: organizationId, first_name: name, last_name: "TestFixture", status: "active" })
    .select("id")
    .single();
  if (error) throw error;
  return created!.id as string;
}

/**
 * Satisfies the first-manager completion gate (20260811100047) for every
 * CURRENT line on a purchase document that doesn't already have a
 * CONFIRMED classification -- confirms each as a throwaway NON_INVENTORY
 * item, which needs no receiving/measurement/location data at all. Exists
 * purely so the large pre-existing purchase-document lifecycle test suite
 * (maker-checker, amendments, revisions, discard/withdraw, duplicate
 * detection -- none of which are about item classification) can still
 * reach READY_FOR_VERIFICATION without individually modeling item mapping;
 * tests that ARE about classification/receiving set it up explicitly
 * themselves instead of calling this.
 */
/** Every CONFIRMED item requires a spend category (20260811100051/100052)
 * -- find-or-create one reusable throwaway spend category per organization
 * so every call site of confirmAllCurrentLinesNonInventory (the large
 * pre-existing purchase-document lifecycle test suite, none of which is
 * actually about spend categories) keeps working with zero setup of its
 * own. */
export async function findOrCreateThrowawaySpendCategory(supabase: SupabaseClient, organizationId: string): Promise<string> {
  const name = "TEST Throwaway Spend Category";
  const { data: existing } = await supabase.from("spend_categories").select("id").eq("organization_id", organizationId).ilike("name", name).maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase.from("spend_categories").insert({ organization_id: organizationId, name, parent_id: null }).select("id").single();
  if (error) throw error;
  return created!.id as string;
}

export async function confirmAllCurrentLinesNonInventory(
  supabase: SupabaseClient,
  organizationId: string,
  appUserId: string,
  purchaseDocumentId: string
): Promise<void> {
  const { data: lines } = await supabase.from("purchase_document_lines").select("line_key").eq("purchase_document_id", purchaseDocumentId);
  const { data: classifications } = await supabase
    .from("purchase_document_line_classifications")
    .select("line_key, status")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId);
  const confirmedLineKeys = new Set((classifications ?? []).filter((c) => c.status === "CONFIRMED").map((c) => c.line_key as string));

  const remaining = (lines ?? []).filter((line) => !confirmedLineKeys.has(line.line_key as string));
  if (remaining.length === 0) return;

  const spendCategoryId = await findOrCreateThrowawaySpendCategory(supabase, organizationId);

  for (const line of remaining) {
    const lineKey = line.line_key as string;
    await approveLineClassificationNewItemRpc(supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId,
      appUserId,
      finalName: `Test Non-Inventory Line ${lineKey.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });
  }
}

/**
 * For the handful of atomic-submit-with-payload tests where the exact
 * final content (in particular description, one of the 4 staleness-
 * snapshot fields) isn't known/persisted until the SAME transaction that
 * also checks the completion gate -- approveLineClassificationNewItemRpc
 * can't be used here because it requires the line to already exist in
 * purchase_document_lines AND takes its snapshot from whatever is
 * currently persisted there, which would go stale the instant the atomic
 * submit inserts genuinely different content. This writes the
 * classification row directly with an explicit snapshot matching the
 * content that's ABOUT to be submitted, so 20260811100037's invalidation
 * trigger sees a match (not a mismatch) when that content is inserted,
 * and the completion gate finds it CONFIRMED, never STALE. NON_INVENTORY
 * with no inventory_item_id -- the gate's receiving checks only apply to
 * disposition='INVENTORY', so this satisfies it with zero other setup.
 */
export async function confirmLineWithSnapshot(
  supabase: SupabaseClient,
  organizationId: string,
  purchaseDocumentId: string,
  lineKey: string,
  snapshot: { vendorSku: string | null; description: string | null; packageUnit: string | null; measuredUnit: string | null }
): Promise<void> {
  const { error } = await supabase.from("purchase_document_line_classifications").upsert(
    {
      organization_id: organizationId,
      purchase_document_id: purchaseDocumentId,
      line_key: lineKey,
      disposition: "NON_INVENTORY",
      inventory_item_id: null,
      resolution_source: "MANUAL",
      status: "CONFIRMED",
      resolved_against_snapshot: { vendorSku: snapshot.vendorSku, description: snapshot.description, packageUnit: snapshot.packageUnit, measuredUnit: snapshot.measuredUnit },
      resolved_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,purchase_document_id,line_key" }
  );
  if (error) throw error;
}
