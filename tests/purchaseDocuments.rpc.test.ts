import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { finalizeDocumentUploadRpc } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";
import { NotPreparerError, CannotSelfVerifyError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";
import { findPossibleDuplicatePurchaseDocuments } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentType, PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * Covers exactly the class of behavior a mocked `supabase.rpc()` cannot:
 * real transactional atomicity, the segregation-of-duties identity checks
 * against real documents.uploaded_by_app_user_id, optimistic-concurrency
 * races under real Postgres row locking, and the append-only audit_events
 * trail across a real submit/return/resubmit/verify cycle.
 *
 * Cleanup semantics differ deliberately by lifecycle stage: while a
 * purchase_document is DRAFT, nothing blocks a real DELETE, so DRAFT-only
 * tests are free to leave rows behind without special handling (this repo
 * doesn't build teardown for RPC tests generally -- see withdrawal.rpc.test.ts).
 * Only VERIFIED rows are permanently un-deletable (by design, the freeze
 * trigger) -- same "no cleanup path" tradeoff already accepted for
 * documents/document_extractions/inventory_movements.
 */

let fx: RpcTestFixtures;

const LINE_A: NormalizedInvoiceLine = {
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

function fakeExtraction(overrides: Record<string, unknown> = {}) {
  return {
    documentType: "INVOICE",
    vendorName: "Baldor Specialty Foods",
    vendorAddress: null,
    vendorPhone: null,
    invoiceNumber: "839291",
    invoiceDate: "2026-08-12",
    deliveryDate: null,
    purchaseOrderNumber: null,
    subtotal: 134.7,
    tax: 0,
    fees: 0,
    total: 134.7,
    currency: "USD",
    lines: [LINE_A],
    warnings: [],
    ...overrides,
  };
}

/** Uploads a document (vendor-first intake) and drives its first extraction
 * attempt straight to SUCCEEDED (bypassing Gemini entirely) so tests can
 * initialize a purchase_document draft from it. */
async function createSucceededDocument(
  uploadedByAppUserId: string,
  extraction: Record<string, unknown> = fakeExtraction()
): Promise<{ documentId: string; extractionId: string }> {
  const documentId = randomUUID();
  const finalizeResult = await finalizeDocumentUploadRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    uploadedByAppUserId,
    storagePath: `org/${fx.organizationId}/documents/${documentId}/original.pdf`,
    originalFilename: "test.pdf",
    contentType: "application/pdf",
    byteSize: 1000,
    fileSha256: randomBytes(32).toString("hex"),
    provider: "gemini",
    model: "gemini-3.6-flash",
    vendorId: fx.vendorId,
    declaredDocumentType: "INVOICE",
  });

  // The transition-guard trigger only allows PENDING -> RUNNING -> SUCCEEDED.
  await fx.supabase.from("document_extractions").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", finalizeResult.attemptId);
  const { error } = await fx.supabase
    .from("document_extractions")
    .update({ status: "SUCCEEDED", completed_at: new Date().toISOString(), normalized_extraction: extraction, review_flags: [] })
    .eq("id", finalizeResult.attemptId);
  if (error) throw error;

  return { documentId, extractionId: finalizeResult.attemptId };
}

/** Same as createSucceededDocument, but every identity fact is a parameter
 * instead of implicitly fx.* -- needed for cross-org fixtures and for
 * duplicate-detection tests that need a specific vendor/type combination. */
async function createSucceededDocumentInOrg(opts: {
  organizationId: string;
  uploadedByAppUserId: string;
  vendorId: string;
  declaredDocumentType: "INVOICE" | "RECEIPT" | "CREDIT_MEMO";
  extraction?: Record<string, unknown>;
}): Promise<{ documentId: string; extractionId: string }> {
  const documentId = randomUUID();
  const finalizeResult = await finalizeDocumentUploadRpc(fx.supabase, {
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
    declaredDocumentType: opts.declaredDocumentType,
  });

  await fx.supabase
    .from("document_extractions")
    .update({ status: "RUNNING", started_at: new Date().toISOString() })
    .eq("id", finalizeResult.attemptId);
  const { error } = await fx.supabase
    .from("document_extractions")
    .update({
      status: "SUCCEEDED",
      completed_at: new Date().toISOString(),
      normalized_extraction: opts.extraction ?? fakeExtraction({ documentType: opts.declaredDocumentType }),
      review_flags: [],
    })
    .eq("id", finalizeResult.attemptId);
  if (error) throw error;

  return { documentId, extractionId: finalizeResult.attemptId };
}

/** Drives a document all the way to a purchase_document with a specific,
 * caller-chosen (vendor, document_type, document_number) and, optionally,
 * lifecycle status -- the exact combination duplicate-detection tests need
 * to control precisely, across organizations. */
async function createPurchaseDocumentWithNumber(opts: {
  organizationId: string;
  appUserId: string;
  vendorId: string;
  documentType: PurchaseDocumentType;
  documentNumber: string;
  status?: PurchaseDocumentStatus;
  verifierAppUserId?: string;
}): Promise<{ purchaseDocumentId: string }> {
  const { documentId } = await createSucceededDocumentInOrg({
    organizationId: opts.organizationId,
    uploadedByAppUserId: opts.appUserId,
    vendorId: opts.vendorId,
    declaredDocumentType: opts.documentType,
  });
  const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
    documentId,
    organizationId: opts.organizationId,
    appUserId: opts.appUserId,
  });
  const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: opts.organizationId,
    appUserId: opts.appUserId,
    expectedVersion: 1,
    header: {
      vendorId: opts.vendorId,
      documentType: opts.documentType,
      documentNumber: opts.documentNumber,
      documentDate: "2026-08-10",
      poNumber: null,
      deliveryDate: null,
      subtotal: 100,
      tax: 0,
      fees: 0,
      total: 100,
      currency: "USD",
    },
    lines: [LINE_A],
  });

  let version = saved.version;
  if (opts.status === "READY_FOR_VERIFICATION" || opts.status === "VERIFIED") {
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: opts.organizationId,
      appUserId: opts.appUserId,
      expectedVersion: version,
    });
    version = submitted.version;

    if (opts.status === "VERIFIED") {
      await verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: opts.organizationId,
        appUserId: opts.verifierAppUserId ?? fx.lockedEmployeeAppUserId,
        expectedVersion: version,
      });
    }
  }

  return { purchaseDocumentId: draft.purchaseDocumentId };
}

/** Preparer submits, leaving the record READY_FOR_VERIFICATION -- the
 * shared starting point for segregation-of-duties, duplicate-verify, and
 * trigger-level lock tests below. */
async function createReadyForVerificationDocument(): Promise<{ purchaseDocumentId: string; version: number }> {
  const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
  const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
  });
  const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
  });
  return { purchaseDocumentId: draft.purchaseDocumentId, version: submitted.version };
}

const HEADER: PurchaseDocumentHeaderDraft = {
  vendorId: null, // filled in per-test from fx.vendorId
  documentType: "INVOICE",
  documentNumber: "839291",
  documentDate: "2026-08-12",
  poNumber: null,
  deliveryDate: null,
  subtotal: 134.7,
  tax: 0,
  fees: 0,
  total: 134.7,
  currency: "USD",
};

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("initialize_purchase_document_draft", () => {
  it("creates a draft prefilled from the human-declared documents fields (not Gemini's guess), and is idempotent", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);

    const first = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(first.created).toBe(true);
    expect(first.status).toBe("DRAFT");

    const { data: row } = await fx.supabase.from("purchase_documents").select("vendor_id, document_type").eq("id", first.purchaseDocumentId).single();
    expect(row!.vendor_id).toBe(fx.vendorId); // from documents.vendor_id, not Gemini's "Baldor Specialty Foods" text
    expect(row!.document_type).toBe("INVOICE"); // from documents.declared_document_type

    const second = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(second).toEqual({ purchaseDocumentId: first.purchaseDocumentId, status: "DRAFT", created: false });

    const { count } = await fx.supabase
      .from("purchase_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_document_id", documentId);
    expect(count).toBe(1);
  });

  it("is preparer-only: a different app_user cannot initialize the draft", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);

    await expect(
      initializePurchaseDocumentDraftRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});

describe("save_purchase_document_draft", () => {
  it("the preparer can save header + lines; a different app_user cannot", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await expect(
      savePurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [LINE_A],
      })
    ).rejects.toBeInstanceOf(NotPreparerError);

    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "CORRECTED-1" },
      lines: [LINE_A, { ...LINE_A, vendorSku: "SKU-B", description: "Napkins" }],
    });
    expect(saved.version).toBe(2);

    const { data: lines } = await fx.supabase
      .from("purchase_document_lines")
      .select("vendor_sku")
      .eq("purchase_document_id", draft.purchaseDocumentId)
      .order("line_number");
    expect((lines ?? []).map((l) => l.vendor_sku)).toEqual(["SKU-A", "SKU-B"]);
  });

  it("rejects a stale version without changing anything", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await expect(
      savePurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 999,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [LINE_A],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("two concurrent saves with the same expected_version -- exactly one succeeds", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    const attempt = () =>
      savePurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [LINE_A],
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);
  });
});

describe("submit_purchase_document_for_verification", () => {
  it("rejects an incomplete draft (missing vendor) and succeeds once complete", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    // Clear the vendor to force an incomplete draft.
    const cleared = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: null },
      lines: [LINE_A],
    });

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: cleared.version,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const fixed = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: cleared.version,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [LINE_A],
    });

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: fixed.version,
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");
  });

  it("is preparer-only", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});

describe("segregation of duties: verify_purchase_document / return_purchase_document_to_draft", () => {
  it("the uploader cannot verify their own submission -- rejected with CannotSelfVerifyError, record completely unchanged", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();

    const before = await fx.supabase.from("purchase_documents").select("status, version").eq("id", purchaseDocumentId).single();

    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId, // the uploader/preparer
        expectedVersion: version,
      })
    ).rejects.toBeInstanceOf(CannotSelfVerifyError);

    const after = await fx.supabase.from("purchase_documents").select("status, version").eq("id", purchaseDocumentId).single();
    expect(after.data).toEqual(before.data); // true no-op
  });

  it("a different manager CAN verify -- verified_by is stored separately from and never equal to the uploader, and zero inventory_movements are created", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();

    const beforeMovements = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });

    const result = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId, // a different manager
      expectedVersion: version,
    });
    expect(result.verifiedAt).toBeTruthy();

    const { data: row } = await fx.supabase
      .from("purchase_documents")
      .select("status, verified_by_app_user_id")
      .eq("id", purchaseDocumentId)
      .single();
    expect(row!.status).toBe("VERIFIED");
    expect(row!.verified_by_app_user_id).toBe(fx.lockedEmployeeAppUserId);
    expect(row!.verified_by_app_user_id).not.toBe(fx.changeableEmployeeAppUserId);

    const afterMovements = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });
    expect(afterMovements.count).toBe(beforeMovements.count);

    // Frozen: even the original preparer can no longer touch it -- the
    // RPC's status='DRAFT' gate fails regardless of which version is
    // passed, since the row is now permanently VERIFIED.
    await expect(
      savePurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [LINE_A],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("the preparer cannot return their own submission to draft either (same identity check as verify)", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();

    await expect(
      returnPurchaseDocumentToDraftRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: version,
      })
    ).rejects.toBeInstanceOf(CannotSelfVerifyError);
  });

  it("a different manager can return it to draft with a reason, and the original preparer can then edit it again", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();

    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
      reason: "Wrong vendor selected",
    });
    expect(returned.status).toBe("DRAFT");

    const { data: row } = await fx.supabase.from("purchase_documents").select("last_returned_reason").eq("id", purchaseDocumentId).single();
    expect(row!.last_returned_reason).toBe("Wrong vendor selected");

    // Editing rights automatically revert to the original preparer.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: returned.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "CORRECTED-AFTER-RETURN" },
      lines: [LINE_A],
    });
    expect(saved.version).toBe(returned.version + 1);
  });
});

describe("audit trail: submit -> return -> resubmit -> verify", () => {
  it("both SUBMITTED events remain distinct (version A vs. version B line values), and VERIFIED identifies version B", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    const submittedA = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submittedA.version,
      reason: "Please add the delivery fee line",
    });

    const modified = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: returned.version,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [LINE_A, { ...LINE_A, vendorSku: "DELIVERY", description: "Delivery Fee", packageQuantity: 1, lineTotal: 15, unitPrice: 15 }],
    });

    const submittedB = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: modified.version,
    });

    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submittedB.version,
    });
    expect(verified.verifiedAt).toBeTruthy();

    const { data: submittedEvents } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .order("occurred_at", { ascending: true });
    expect(submittedEvents).toHaveLength(2);
    expect((submittedEvents![0].after_state as { lines: unknown[] }).lines).toHaveLength(1);
    expect((submittedEvents![1].after_state as { lines: unknown[] }).lines).toHaveLength(2);
    expect((submittedEvents![0].after_state as { version: number }).version).toBe(submittedA.version);
    expect((submittedEvents![1].after_state as { version: number }).version).toBe(submittedB.version);

    const { data: returnedEvents } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_RETURNED");
    expect(returnedEvents).toHaveLength(1);
    expect((returnedEvents![0].after_state as { reason: string }).reason).toBe("Please add the delivery fee line");

    const { data: verifiedEvents } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED");
    expect(verifiedEvents).toHaveLength(1);
    expect((verifiedEvents![0].after_state as { version: number }).version).toBe(submittedB.version);

    // The first SUBMITTED event's snapshot is untouched by everything since.
    const { data: reReadFirst } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .order("occurred_at", { ascending: true })
      .limit(1)
      .single();
    expect(reReadFirst!.after_state).toEqual(submittedEvents![0].after_state);
  });
});

describe("verify_purchase_document: a second/duplicate verify call after success", () => {
  it("fails safely without a second VERIFIED audit event, and leaves the record unchanged", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();

    const first = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
    });
    expect(first.verifiedAt).toBeTruthy();

    const { data: afterFirst } = await fx.supabase
      .from("purchase_documents")
      .select("status, version, verified_at")
      .eq("id", purchaseDocumentId)
      .single();
    expect(afterFirst!.status).toBe("VERIFIED");

    // Same (now-stale) expected_version as the first call -- rejected.
    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: version,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    // Even the CURRENT version fails -- the row is no longer
    // READY_FOR_VERIFICATION at all, so there is no "current version that
    // would work" for a second verify call.
    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: afterFirst!.version,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const { data: afterSecondAttempts } = await fx.supabase
      .from("purchase_documents")
      .select("status, version, verified_at")
      .eq("id", purchaseDocumentId)
      .single();
    expect(afterSecondAttempts).toEqual(afterFirst);

    const { data: verifiedEvents } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED");
    expect(verifiedEvents).toHaveLength(1);
  });
});

describe("READY_FOR_VERIFICATION trigger-level lock (raw bypass attempts, not RPC WHERE clauses)", () => {
  it("rejects a raw header UPDATE that changes a business field", async () => {
    const { purchaseDocumentId } = await createReadyForVerificationDocument();
    const { error } = await fx.supabase.from("purchase_documents").update({ document_number: "HACKED" }).eq("id", purchaseDocumentId);
    expect(error?.code).toBe("GA003");

    const { data: row } = await fx.supabase.from("purchase_documents").select("document_number").eq("id", purchaseDocumentId).single();
    expect(row!.document_number).not.toBe("HACKED");
  });

  it("rejects a raw DELETE", async () => {
    const { purchaseDocumentId } = await createReadyForVerificationDocument();
    const { error } = await fx.supabase.from("purchase_documents").delete().eq("id", purchaseDocumentId);
    expect(error?.code).toBe("GA003");
  });

  it("rejects a raw line INSERT", async () => {
    const { purchaseDocumentId } = await createReadyForVerificationDocument();
    const { error } = await fx.supabase.from("purchase_document_lines").insert({
      organization_id: fx.organizationId,
      purchase_document_id: purchaseDocumentId,
      line_number: 99,
      description: "sneaky",
    });
    expect(error?.code).toBe("GA003");
  });

  it("rejects a raw line UPDATE", async () => {
    const { purchaseDocumentId } = await createReadyForVerificationDocument();
    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1);
    const { error } = await fx.supabase.from("purchase_document_lines").update({ description: "HACKED" }).eq("id", lines![0].id);
    expect(error?.code).toBe("GA003");
  });

  it("rejects a raw line DELETE", async () => {
    const { purchaseDocumentId } = await createReadyForVerificationDocument();
    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1);
    const { error } = await fx.supabase.from("purchase_document_lines").delete().eq("id", lines![0].id);
    expect(error?.code).toBe("GA003");
  });

  it("the legitimate READY_FOR_VERIFICATION -> VERIFIED RPC transition still succeeds (the trigger doesn't block sanctioned transitions)", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();
    const result = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
    });
    expect(result.verifiedAt).toBeTruthy();
  });

  it("the legitimate READY_FOR_VERIFICATION -> DRAFT return RPC transition still succeeds", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();
    const result = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
    });
    expect(result.status).toBe("DRAFT");
  });

  it("rejects a raw mutation of a VERIFIED header", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
    });

    const { error } = await fx.supabase.from("purchase_documents").update({ document_number: "HACKED" }).eq("id", purchaseDocumentId);
    expect(error?.code).toBe("GA003");
  });

  it("rejects raw insert/update/delete of VERIFIED lines", async () => {
    const { purchaseDocumentId, version } = await createReadyForVerificationDocument();
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: version,
    });

    const insertResult = await fx.supabase
      .from("purchase_document_lines")
      .insert({ organization_id: fx.organizationId, purchase_document_id: purchaseDocumentId, line_number: 99, description: "sneaky" });
    expect(insertResult.error?.code).toBe("GA003");

    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1);
    const updateResult = await fx.supabase.from("purchase_document_lines").update({ description: "HACKED" }).eq("id", lines![0].id);
    expect(updateResult.error?.code).toBe("GA003");

    const deleteResult = await fx.supabase.from("purchase_document_lines").delete().eq("id", lines![0].id);
    expect(deleteResult.error?.code).toBe("GA003");
  });
});

describe("findPossibleDuplicatePurchaseDocuments -- real DB row-level proof", () => {
  it("matches same org/vendor/type/number; a different vendor, a different type, and a different org do not; self is excluded", async () => {
    const documentNumber = `DUP-${randomUUID().slice(0, 8)}`;

    const original = await createPurchaseDocumentWithNumber({
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });

    const sameEverything = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    expect(sameEverything.map((d) => d.purchaseDocumentId)).toContain(original.purchaseDocumentId);

    const excludingSelf = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
      excludePurchaseDocumentId: original.purchaseDocumentId,
    });
    expect(excludingSelf.map((d) => d.purchaseDocumentId)).not.toContain(original.purchaseDocumentId);

    const differentVendor = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.inactiveVendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    expect(differentVendor.map((d) => d.purchaseDocumentId)).not.toContain(original.purchaseDocumentId);

    const differentType = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "RECEIPT",
      documentNumber,
    });
    expect(differentType.map((d) => d.purchaseDocumentId)).not.toContain(original.purchaseDocumentId);

    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    await createPurchaseDocumentWithNumber({
      organizationId: otherOrg.organizationId,
      appUserId: otherOrg.appUserId,
      vendorId: otherOrg.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    const withinOriginalOrg = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    // The other organization's row shares organization-agnostic fields
    // (same vendor NAME pattern, same type, same number) but must never
    // appear here -- only the original org's own record does.
    expect(withinOriginalOrg).toHaveLength(1);
    expect(withinOriginalOrg[0].purchaseDocumentId).toBe(original.purchaseDocumentId);
  });

  it("null/blank document number never triggers a duplicate check", async () => {
    const resultNull = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber: null,
    });
    expect(resultNull).toEqual([]);

    const resultBlank = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber: "   ",
    });
    expect(resultBlank).toEqual([]);
  });

  it("represents DRAFT, READY_FOR_VERIFICATION, and VERIFIED matches with their real status", async () => {
    const documentNumber = `DUP-STATUS-${randomUUID().slice(0, 8)}`;

    const draft = await createPurchaseDocumentWithNumber({
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      vendorId: fx.vendorId,
      documentType: "CREDIT_MEMO",
      documentNumber,
      status: "DRAFT",
    });
    const ready = await createPurchaseDocumentWithNumber({
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      vendorId: fx.vendorId,
      documentType: "CREDIT_MEMO",
      documentNumber,
      status: "READY_FOR_VERIFICATION",
    });
    const verified = await createPurchaseDocumentWithNumber({
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      vendorId: fx.vendorId,
      documentType: "CREDIT_MEMO",
      documentNumber,
      status: "VERIFIED",
    });

    const matches = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "CREDIT_MEMO",
      documentNumber,
    });

    const statusById = new Map(matches.map((m) => [m.purchaseDocumentId, m.status]));
    expect(statusById.get(draft.purchaseDocumentId)).toBe("DRAFT");
    expect(statusById.get(ready.purchaseDocumentId)).toBe("READY_FOR_VERIFICATION");
    expect(statusById.get(verified.purchaseDocumentId)).toBe("VERIFIED");
  });
});
