import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { finalizeDocumentUploadRpc } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { getReceivingQueue } from "@/app/lib/documents/receivingQueue";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import type { PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (see purchaseDocuments.rpc.test.ts
 * for the shared rationale). This file specifically proves the fix for the
 * "filter after limit(200)" bug: a genuinely matching record older than the
 * newest 200 uploads must still surface once search_receiving_queue filters
 * BEFORE its own limit, not after.
 */

let fx: RpcTestFixtures;

const LINE_A: PurchaseDocumentLine = {
  lineKey: null,
  vendorSku: "SKU-A",
  description: "Chicken Thigh",
  packageQuantity: 5,
  packageUnit: "CS",
  measuredQuantity: 90.4,
  measuredUnit: "LB",
  unitPrice: 1.49,
  priceBasisUnit: "LB",
  lineTotal: 134.7,
  rawLineText: null,
};

async function createDraftPurchaseDocument(documentNumber: string): Promise<{ documentId: string; purchaseDocumentId: string }> {
  const documentId = randomUUID();
  const finalizeResult = await finalizeDocumentUploadRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    storagePath: `org/${fx.organizationId}/documents/${documentId}/original.pdf`,
    originalFilename: "queue-target.pdf",
    contentType: "application/pdf",
    byteSize: 1000,
    fileSha256: randomBytes(32).toString("hex"),
    provider: "gemini",
    model: "gemini-3.6-flash",
    vendorId: fx.vendorId,
    declaredDocumentType: "INVOICE",
  });
  await fx.supabase.from("document_extractions").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", finalizeResult.attemptId);
  await fx.supabase
    .from("document_extractions")
    .update({
      status: "SUCCEEDED",
      completed_at: new Date().toISOString(),
      normalized_extraction: { documentType: "INVOICE", vendorName: "x", lines: [LINE_A], warnings: [] },
      review_flags: [],
    })
    .eq("id", finalizeResult.attemptId);

  const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
  });
  await savePurchaseDocumentDraftRpc(fx.supabase, {
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
    header: {
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
      documentDate: "2026-08-10",
      poNumber: null,
      deliveryDate: null,
      subtotal: 134.7,
      tax: 0,
      fees: 0,
      total: 134.7,
      currency: "USD",
    },
    lines: [LINE_A],
  });

  return { documentId, purchaseDocumentId: draft.purchaseDocumentId };
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
}, 60_000);

describe("search_receiving_queue -- filtering happens before the limit, not after", () => {
  it(
    "a matching record older than the newest 200 uploads still appears once vendor-filtered, even though 200 newer unrelated documents exist",
    async () => {
      const documentNumber = `QUEUE-${randomUUID().slice(0, 8)}`;
      const target = await createDraftPurchaseDocument(documentNumber);

      // documents is immutable (forbid_update_delete) -- there is no way to
      // backdate the target's created_at after the fact, and there
      // shouldn't be. Instead, read back its real (just-inserted) created_at
      // and insert 200 filler documents with created_at values explicitly
      // AFTER it -- strictly newer by construction, regardless of wall-clock
      // "now" or whatever else already exists in the org from prior runs.
      // That alone guarantees at least 200 rows outrank the target in a
      // plain created_at-desc ordering, without ever mutating the target row.
      const { data: targetDoc, error: targetDocError } = await fx.supabase
        .from("documents")
        .select("created_at")
        .eq("id", target.documentId)
        .single();
      if (targetDocError) throw targetDocError;
      const baseTimeMs = new Date(targetDoc!.created_at).getTime();

      // 200 unrelated, newer filler documents -- no vendor, no
      // purchase_document, exactly the volume that would previously have
      // truncated the queue query before any filter ran.
      const fillerRows = Array.from({ length: 200 }, (_, i) => ({
        organization_id: fx.organizationId,
        uploaded_by_app_user_id: fx.changeableEmployeeAppUserId,
        storage_path: `org/${fx.organizationId}/documents/queue-filler-${randomUUID()}/original.pdf`,
        original_filename: `filler-${i}.pdf`,
        content_type: "application/pdf",
        byte_size: 1000,
        file_sha256: randomBytes(32).toString("hex"),
        created_at: new Date(baseTimeMs + (i + 1) * 1000).toISOString(),
      }));
      const { error: fillerError } = await fx.supabase.from("documents").insert(fillerRows);
      if (fillerError) throw fillerError;

      // Unfiltered call would only see the newest 200 -- the target,
      // strictly older than all 200 filler rows, is not among them.
      const unfiltered = await getReceivingQueue(fx.organizationId, {});
      expect(unfiltered.find((item) => item.documentId === target.documentId)).toBeUndefined();

      // Vendor-filtered call must still find it: filtering happens before
      // the limit inside search_receiving_queue.
      const vendorFiltered = await getReceivingQueue(fx.organizationId, { vendorId: fx.vendorId, documentType: "INVOICE" });
      const found = vendorFiltered.find((item) => item.documentId === target.documentId);
      expect(found).toBeTruthy();
      expect(found?.documentNumber).toBe(documentNumber);
    },
    60_000
  );

  it("combined filters (vendor + document type + uploaded-by + status + text search) all narrow correctly together", async () => {
    const documentNumber = `QUEUE-COMBINED-${randomUUID().slice(0, 8)}`;
    const target = await createDraftPurchaseDocument(documentNumber);

    const result = await getReceivingQueue(fx.organizationId, {
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      status: "DRAFT",
      q: documentNumber,
    });

    expect(result).toHaveLength(1);
    expect(result[0].documentId).toBe(target.documentId);
    expect(result[0].purchaseDocumentId).toBe(target.purchaseDocumentId);
    expect(result[0].uploadedByName).not.toBe("Unknown");

    // A mismatched status excludes it.
    const wrongStatus = await getReceivingQueue(fx.organizationId, {
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      status: "VERIFIED",
      q: documentNumber,
    });
    expect(wrongStatus.find((item) => item.documentId === target.documentId)).toBeUndefined();
  });
});
