import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { finalizeDocumentUploadRpc } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { getReceivingQueue, getReceivingQueuePage, type ReceivingQueueCursor } from "@/app/lib/documents/receivingQueue";
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
      // truncated the queue query before any filter ran. Spaced ONE
      // MILLISECOND apart (never seconds): they only need to be strictly
      // newer than the target, and stamping them minutes into the FUTURE
      // would occupy every unfiltered queue's newest-200 window for other
      // concurrently-running test files' own assertions -- a real
      // cross-file interference observed under the full suite.
      const fillerRows = Array.from({ length: 200 }, (_, i) => ({
        organization_id: fx.organizationId,
        uploaded_by_app_user_id: fx.changeableEmployeeAppUserId,
        storage_path: `org/${fx.organizationId}/documents/queue-filler-${randomUUID()}/original.pdf`,
        original_filename: `filler-${i}.pdf`,
        content_type: "application/pdf",
        byte_size: 1000,
        file_sha256: randomBytes(32).toString("hex"),
        created_at: new Date(baseTimeMs + i + 1).toISOString(),
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

  it(
    "combined filters (vendor + document type + uploaded-by + status + text search) all narrow correctly together",
    async () => {
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
    },
    // Real-Postgres round trips (createDraftPurchaseDocument's own extraction
    // + draft + save chain, plus two getReceivingQueue search calls) against
    // the linked DEV database -- the sibling test above in this same file
    // already needed the identical explicit timeout for the same reason
    // (this file is never run under CI's stricter time budget, only
    // manually/on-demand). Vitest's 5s default was never enough headroom
    // here even in isolation under any real network latency, and gets
    // tighter still when 22 .rpc.test.ts files run concurrently against the
    // same instance -- a longer timeout, not a weaker assertion, is the
    // correct fix for a genuinely slower integration test.
    60_000
  );
});

describe("search_receiving_queue -- keyset pagination (20260811100150)", () => {
  /** Five bare documents (no extraction -> derived status FAILED) with a
   * run-unique filename tag so p_query scopes every assertion to exactly
   * these rows, and with EXPLICIT created_at values including one shared
   * timestamp -- proving the (created_at, document_id) tiebreaker keeps
   * ordering and cursors deterministic where created_at alone could not. */
  async function insertTaggedDocuments(tag: string): Promise<string[]> {
    const baseTimeMs = Date.now() - 60_000;
    const rows = Array.from({ length: 5 }, (_, i) => ({
      organization_id: fx.organizationId,
      uploaded_by_app_user_id: fx.changeableEmployeeAppUserId,
      storage_path: `org/${fx.organizationId}/documents/${tag}-${randomUUID()}/original.pdf`,
      original_filename: `${tag}-${i}.pdf`,
      content_type: "application/pdf",
      byte_size: 1000,
      file_sha256: randomBytes(32).toString("hex"),
      // Rows 2 and 3 share ONE timestamp on purpose.
      created_at: new Date(baseTimeMs + (i === 3 ? 2 : i) * 1000).toISOString(),
    }));
    const { data, error } = await fx.supabase.from("documents").insert(rows).select("id");
    if (error) throw error;
    return (data ?? []).map((r) => r.id as string);
  }

  it(
    "pages converge with no duplicates or gaps, deterministically, including same-timestamp rows",
    async () => {
      const tag = `keyset-${randomUUID().slice(0, 8)}`;
      const insertedIds = await insertTaggedDocuments(tag);

      // Small pages via the RPC directly (the wrapper's page size is
      // fixed at 50) -- exercising the exact cursor mechanics.
      const walk = async (): Promise<string[]> => {
        const seen: string[] = [];
        let cursor: ReceivingQueueCursor | null = null;
        for (let page = 0; page < 6; page += 1) {
          const { data, error } = await fx.supabase.rpc("search_receiving_queue", {
            p_organization_id: fx.organizationId,
            p_query: tag,
            p_limit: 2,
            p_before_created_at: cursor?.beforeCreatedAt ?? null,
            p_before_document_id: cursor?.beforeDocumentId ?? null,
          });
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as { out_document_id: string; out_created_at: string }[];
          if (rows.length === 0) break;
          for (const row of rows) seen.push(row.out_document_id);
          const last = rows[rows.length - 1];
          cursor = { beforeCreatedAt: last.out_created_at, beforeDocumentId: last.out_document_id };
          if (rows.length < 2) break;
        }
        return seen;
      };

      const first = await walk();
      const second = await walk();
      expect(first).toHaveLength(5);
      expect(new Set(first).size).toBe(5);
      expect(new Set(first)).toEqual(new Set(insertedIds));
      expect(second).toEqual(first);

      // The wrapper's single full page agrees with the walked order.
      const wrapperPage = await getReceivingQueuePage(fx.organizationId, { q: tag });
      expect(wrapperPage.items.map((i) => i.documentId)).toEqual(first);
      expect(wrapperPage.nextCursor).toBeNull();
    },
    60_000
  );

  it(
    "the tab's status SET filters before the limit, matching the tab semantics",
    async () => {
      const tag = `keyset-${randomUUID().slice(0, 8)}`;
      await insertTaggedDocuments(tag); // bare docs derive status FAILED

      const needsAttention = await getReceivingQueuePage(fx.organizationId, { q: tag }, ["NEEDS_REVIEW", "STALLED", "FAILED", "DRAFT"]);
      expect(needsAttention.items).toHaveLength(5);
      for (const item of needsAttention.items) expect(item.status).toBe("FAILED");

      const verifiedOnly = await getReceivingQueuePage(fx.organizationId, { q: tag }, ["VERIFIED"]);
      expect(verifiedOnly.items).toHaveLength(0);

      // A DRAFT document (full pipeline) matches the Needs Attention set.
      const documentNumber = `KEYSET-DRAFT-${randomUUID().slice(0, 8)}`;
      const draft = await createDraftPurchaseDocument(documentNumber);
      const draftInSet = await getReceivingQueuePage(fx.organizationId, { q: documentNumber }, ["NEEDS_REVIEW", "STALLED", "FAILED", "DRAFT"]);
      expect(draftInSet.items.map((i) => i.documentId)).toContain(draft.documentId);
      const draftOutOfSet = await getReceivingQueuePage(fx.organizationId, { q: documentNumber }, ["READY_FOR_VERIFICATION"]);
      expect(draftOutOfSet.items).toHaveLength(0);
    },
    60_000
  );
});
