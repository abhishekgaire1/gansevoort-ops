import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { finalizeDocumentUploadRpc } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { discardPurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/discardPurchaseDocumentDraftRpc";
import { withdrawPurchaseDocumentSubmissionRpc } from "@/app/lib/purchaseDocuments/withdrawPurchaseDocumentSubmissionRpc";
import { archiveDocumentRpc } from "@/app/lib/documents/archiveDocumentRpc";
import { NotPreparerError, CannotSelfVerifyError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";
import { findPossibleDuplicatePurchaseDocuments } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { getReceivingQueue } from "@/app/lib/documents/receivingQueue";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { confirmAllCurrentLinesNonInventory, confirmLineWithSnapshot, getLineKeys } from "./itemMasterTestHelpers";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType, PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

/**
 * The first-manager completion gate (20260811100047) now requires every
 * CURRENT line to have a CONFIRMED classification before
 * submit_purchase_document_for_verification succeeds -- added AFTER this
 * entire test file, whose ~2500 lines test maker-checker/amendment/
 * revision/discard/duplicate-detection behavior that has nothing to do
 * with item classification. confirmAllCurrentLinesNonInventory (imported
 * above) satisfies the gate cheaply (a throwaway NON_INVENTORY item needs
 * no receiving data) wherever a test needs a document to actually reach
 * READY_FOR_VERIFICATION/VERIFIED -- it's a no-op for tests expecting
 * submit to fail for an unrelated reason (stale version, wrong preparer,
 * etc.), since those still fail before the gate is ever reached.
 */
async function submitReady(
  input: Parameters<typeof submitPurchaseDocumentForVerificationRpc>[1]
): ReturnType<typeof submitPurchaseDocumentForVerificationRpc> {
  await confirmAllCurrentLinesNonInventory(fx.supabase, input.organizationId, input.appUserId, input.purchaseDocumentId);
  return submitPurchaseDocumentForVerificationRpc(fx.supabase, input);
}

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
    const submitted = await submitReady({
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
  const submitted = await submitReady({
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
  });
  return { purchaseDocumentId: draft.purchaseDocumentId, version: submitted.version };
}

/** Same as createReadyForVerificationDocument, but with a caller-chosen
 * document number/total and a real client-generated lineKey on the single
 * line -- the shared starting point for 2A.2.1's review-correction and
 * amendment tests, which need to control (and later assert on) exact
 * header/line identity across the submit -> correct -> verify -> amend
 * chain. */
async function createReadyForVerificationDocumentWithLine(opts: {
  documentNumber?: string;
  total?: number;
} = {}): Promise<{ purchaseDocumentId: string; version: number; sourceDocumentId: string; lineKey: string; documentNumber: string; total: number }> {
  const documentNumber = opts.documentNumber ?? `REV-${randomUUID().slice(0, 8)}`;
  const total = opts.total ?? 134.7;
  const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
  const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
  });
  const lineKey = randomUUID();
  const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
    header: { ...HEADER, vendorId: fx.vendorId, documentNumber, total },
    lines: [{ ...LINE_A, lineKey }],
  });
  const submitted = await submitReady({
    purchaseDocumentId: draft.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: saved.version,
  });
  return { purchaseDocumentId: draft.purchaseDocumentId, version: submitted.version, sourceDocumentId: documentId, lineKey, documentNumber, total };
}

/** Drives a document all the way to VERIFIED with a known preparer
 * (changeableEmployee) and verifier (lockedEmployee) and a caller-chosen
 * document number/total -- the shared starting point for amendment tests. */
async function createVerifiedRevisionOneDocument(opts: {
  documentNumber?: string;
  total?: number;
} = {}): Promise<{ purchaseDocumentId: string; revisionGroupId: string; sourceDocumentId: string }> {
  const ready = await createReadyForVerificationDocumentWithLine(opts);
  await verifyPurchaseDocumentRpc(fx.supabase, {
    purchaseDocumentId: ready.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.lockedEmployeeAppUserId,
    expectedVersion: ready.version,
  });
  const { data: row } = await fx.supabase.from("purchase_documents").select("revision_group_id").eq("id", ready.purchaseDocumentId).single();
  return { purchaseDocumentId: ready.purchaseDocumentId, revisionGroupId: row!.revision_group_id as string, sourceDocumentId: ready.sourceDocumentId };
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
      submitReady({
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

    const submitted = await submitReady({
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
      submitReady({
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});

describe("submit_purchase_document_for_verification: atomic save-and-submit (regression for the browser 'unsaved edits silently discarded' bug)", () => {
  it("submits the exact current form payload without a prior Save Draft call -- persisted DB values and the SUBMITTED snapshot both reflect it, never the last-saved value", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    // Persist an initial draft with description "OLD" -- simulates the
    // last explicit Save Draft click.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [{ ...LINE_A, description: "OLD" }],
    });
    // The completion gate (20260811100047) needs a CONFIRMED classification
    // matching the content that's ABOUT to be submitted ("NEW") -- not
    // whatever is currently persisted ("OLD"), since the atomic submit's
    // own DELETE+INSERT would otherwise mark it STALE inside the same
    // transaction the gate check runs in. confirmLineWithSnapshot writes
    // that classification directly, snapshotted against "NEW" in advance.
    const [oldLineKey] = await getLineKeys(fx.supabase, draft.purchaseDocumentId);
    await confirmLineWithSnapshot(fx.supabase, fx.organizationId, draft.purchaseDocumentId, oldLineKey, {
      vendorSku: LINE_A.vendorSku,
      description: "NEW",
      packageUnit: LINE_A.packageUnit,
      measuredUnit: LINE_A.measuredUnit,
    });

    // Client-style: the browser's current form state is "NEW" -- Submit is
    // clicked WITHOUT a save first. This is the exact shape of the
    // reported bug: submitPurchaseDocumentForVerificationRpc is called
    // with the current on-screen payload, never a separate save call.
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: saved.version,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [{ ...LINE_A, lineKey: oldLineKey, description: "NEW" }],
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");

    const { data: lines } = await fx.supabase
      .from("purchase_document_lines")
      .select("description")
      .eq("purchase_document_id", draft.purchaseDocumentId);
    expect(lines).toHaveLength(1);
    expect(lines![0].description).toBe("NEW"); // never "OLD"

    const { data: submittedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .single();
    const snapshotLines = (submittedEvent!.after_state as { lines: { description: string }[] }).lines;
    expect(snapshotLines[0].description).toBe("NEW"); // never "OLD"
  });

  it("submits multiple simultaneous unsaved changes -- header total, a modified line, an added line, and a removed line -- all in one atomic call", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const keepKey = randomUUID();
    const removeKey = randomUUID();
    const addedKey = randomUUID();
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 100 },
      lines: [
        { ...LINE_A, lineKey: keepKey, description: "Kept Item", packageQuantity: 1, unitPrice: 10, lineTotal: 10 },
        { ...LINE_A, lineKey: removeKey, description: "To Be Removed" },
      ],
    });
    // keepKey's description doesn't change below (only quantity/price,
    // which the staleness snapshot doesn't track) so the ordinary approve
    // RPC is fine for it. addedKey doesn't exist in purchase_document_lines
    // yet AND its final description ("New Item") only appears in the
    // atomic submit below -- confirmLineWithSnapshot pre-classifies it
    // directly against that exact future content.
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, draft.purchaseDocumentId);
    await confirmLineWithSnapshot(fx.supabase, fx.organizationId, draft.purchaseDocumentId, addedKey, {
      vendorSku: LINE_A.vendorSku,
      description: "New Item",
      packageUnit: LINE_A.packageUnit,
      measuredUnit: LINE_A.measuredUnit,
    });

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: saved.version,
      header: { ...HEADER, vendorId: fx.vendorId, total: 250 },
      lines: [
        { ...LINE_A, lineKey: keepKey, description: "Kept Item", packageQuantity: 5, unitPrice: 20, lineTotal: 100 },
        { ...LINE_A, lineKey: addedKey, description: "New Item", packageQuantity: 1, unitPrice: 150, lineTotal: 150 },
      ],
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");

    const { data: row } = await fx.supabase.from("purchase_documents").select("total").eq("id", draft.purchaseDocumentId).single();
    expect(Number(row!.total)).toBe(250);

    const { data: lines } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key, description, package_quantity, unit_price, line_total")
      .eq("purchase_document_id", draft.purchaseDocumentId);
    expect(lines).toHaveLength(2);
    const byKey = new Map(lines!.map((l) => [l.line_key, l]));
    expect(byKey.get(keepKey)).toMatchObject({ description: "Kept Item", package_quantity: 5, unit_price: 20, line_total: 100 });
    expect(byKey.get(addedKey)).toMatchObject({ description: "New Item" });
    expect(byKey.has(removeKey)).toBe(false); // removed line did not survive

    const { data: submittedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .single();
    const snapshot = submittedEvent!.after_state as { total: string; lines: { line_key: string }[] };
    expect(Number(snapshot.total)).toBe(250);
    expect(snapshot.lines.map((l) => l.line_key).sort()).toEqual([addedKey, keepKey].sort());
  });

  it("preserves a supplied line_key exactly, and rejects duplicate line_key values in the atomic payload", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const explicitKey = randomUUID();
    // Pre-establish explicitKey via an ordinary save (so the completion
    // gate can classify it) before the atomic submit below re-supplies the
    // SAME key -- the test's own assertion is that the key survives
    // exactly, which this preserves.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [{ ...LINE_A, lineKey: explicitKey }],
    });
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, draft.purchaseDocumentId);

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: saved.version,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [{ ...LINE_A, lineKey: explicitKey }],
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");

    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("line_key").eq("purchase_document_id", draft.purchaseDocumentId);
    expect(lines![0].line_key).toBe(explicitKey);

    const { documentId: documentId2 } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft2 = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId: documentId2,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const dupeKey = randomUUID();
    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId: draft2.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [
          { ...LINE_A, lineKey: dupeKey },
          { ...LINE_A, lineKey: dupeKey, vendorSku: "SKU-DUPE" },
        ],
      })
    ).rejects.toThrow();
  });

  it("stale version: a second atomic submit using an outdated expected_version is rejected and never overwrites the first submit's values", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    // Pre-establish a line_key, classified directly against the exact
    // content "Tab A" is about to atomically submit (the test's own
    // subject is version staleness, not item classification --
    // confirmLineWithSnapshot avoids the staleness trigger firing inside
    // Tab A's own atomic submit transaction).
    const tabAKey = randomUUID();
    await confirmLineWithSnapshot(fx.supabase, fx.organizationId, draft.purchaseDocumentId, tabAKey, {
      vendorSku: LINE_A.vendorSku,
      description: "From Tab A",
      packageUnit: LINE_A.packageUnit,
      measuredUnit: LINE_A.measuredUnit,
    });

    // "Tab A" submits first, using version 1.
    const submittedA = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 111 },
      lines: [{ ...LINE_A, lineKey: tabAKey, description: "From Tab A" }],
    });
    expect(submittedA.status).toBe("READY_FOR_VERIFICATION");

    // "Tab B" never saw Tab A's transition and still attempts to submit
    // against the original version 1 -- must be rejected, not silently
    // reapplied on top.
    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId, total: 999 },
        lines: [{ ...LINE_A, description: "From Tab B" }],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const { data: row } = await fx.supabase.from("purchase_documents").select("total, status").eq("id", draft.purchaseDocumentId).single();
    expect(Number(row!.total)).toBe(111);
    expect(row!.status).toBe("READY_FOR_VERIFICATION");
  });

  it("amendment: submitting an edited Rev 2 draft without a prior Save Draft persists the edited values, and Rev 1 remains the current verified revision until Rev 2 is verified", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 300 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "amendment atomic-submit regression test",
    });

    // initiate_purchase_document_amendment already copies Rev 1's line(s)
    // into Rev 2 with a fresh (but persisted) line_key -- reuse that exact
    // key, classified directly against the "Amended Line" content the
    // atomic submit below is about to insert (never what Rev 2 actually
    // starts with, which would go STALE inside that same transaction).
    const [rev2LineKey] = await getLineKeys(fx.supabase, amendment.purchaseDocumentId);
    await confirmLineWithSnapshot(fx.supabase, fx.organizationId, amendment.purchaseDocumentId, rev2LineKey, {
      vendorSku: LINE_A.vendorSku,
      description: "Amended Line",
      packageUnit: LINE_A.packageUnit,
      measuredUnit: LINE_A.measuredUnit,
    });

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 275 },
      lines: [{ ...LINE_A, lineKey: rev2LineKey, description: "Amended Line" }],
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");

    const { data: rev2Row } = await fx.supabase.from("purchase_documents").select("total, status").eq("id", amendment.purchaseDocumentId).single();
    expect(Number(rev2Row!.total)).toBe(275);
    expect(rev2Row!.status).toBe("READY_FOR_VERIFICATION");

    const { data: rev2Lines } = await fx.supabase.from("purchase_document_lines").select("description").eq("purchase_document_id", amendment.purchaseDocumentId);
    expect(rev2Lines![0].description).toBe("Amended Line");

    const { data: rev1Row } = await fx.supabase.from("purchase_documents").select("status, total").eq("id", verified.purchaseDocumentId).single();
    expect(rev1Row!.status).toBe("VERIFIED"); // untouched
    expect(Number(rev1Row!.total)).toBe(300); // untouched

    const { data: currentVerifiedId } = await fx.supabase.rpc("current_verified_purchase_document_revision_id", {
      p_organization_id: fx.organizationId,
      p_revision_group_id: verified.revisionGroupId,
    });
    expect(currentVerifiedId).toBe(verified.purchaseDocumentId); // Rev 1 stays current-verified until Rev 2 is itself verified
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

    const submittedA = await submitReady({
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

    const submittedB = await submitReady({
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

describe("purchase_document_diff (real Postgres) -- regression coverage for the line -> 'value' alias bug fixed in 20260811100030", () => {
  it("with non-empty old AND new lines, correctly returns a modified line, an added line, and a removed line in one call", async () => {
    const oldHeader = { vendor_id: fx.vendorId, document_type: "INVOICE", document_number: "839291", document_date: "2026-08-12", po_number: null, delivery_date: null, subtotal: 100, tax: 0, fees: 0, total: 100, currency: "USD" };
    const newHeader = { ...oldHeader, total: 120 };

    const keyModified = randomUUID();
    const keyRemoved = randomUUID();
    const keyAdded = randomUUID();

    const oldLines = [
      { line_key: keyModified, vendor_sku: "SKU-A", description: "Item A", package_quantity: 1, package_unit: "CS", measured_quantity: null, measured_unit: null, unit_price: 10, price_basis_unit: "CS", line_total: 10 },
      { line_key: keyRemoved, vendor_sku: "SKU-B", description: "Item B", package_quantity: 1, package_unit: "CS", measured_quantity: null, measured_unit: null, unit_price: 20, price_basis_unit: "CS", line_total: 20 },
    ];
    const newLines = [
      { line_key: keyModified, vendor_sku: "SKU-A", description: "Item A", package_quantity: 1, package_unit: "CS", measured_quantity: null, measured_unit: null, unit_price: 15, price_basis_unit: "CS", line_total: 15 },
      { line_key: keyAdded, vendor_sku: "SKU-C", description: "Item C", package_quantity: 1, package_unit: "CS", measured_quantity: null, measured_unit: null, unit_price: 5, price_basis_unit: "CS", line_total: 5 },
    ];

    // This is a direct call to the SQL function itself (not through any
    // wrapper) -- the exact call shape that raised SQLSTATE 42883
    // ("operator does not exist: record -> unknown") before the fix,
    // whenever either lines array was non-empty.
    const { data, error } = await fx.supabase.rpc("purchase_document_diff", {
      p_old_header: oldHeader,
      p_old_lines: oldLines,
      p_new_header: newHeader,
      p_new_lines: newLines,
    });
    expect(error).toBeNull();

    // Values were passed as plain JS numbers and round-trip through jsonb
    // as JSON numbers -- never strings.
    expect(data.headerChanges).toContainEqual({ field: "total", before: 100, after: 120 });

    expect(data.lineChanges).toContainEqual(
      expect.objectContaining({ lineKey: keyRemoved, kind: "removed" })
    );
    expect(data.lineChanges).toContainEqual(
      expect.objectContaining({ lineKey: keyAdded, kind: "added" })
    );
    const modifiedChange = data.lineChanges.find((c: { lineKey: string }) => c.lineKey === keyModified);
    expect(modifiedChange.kind).toBe("modified");
    expect(modifiedChange.fields).toContainEqual({ field: "unit_price", before: 10, after: 15 });
    expect(modifiedChange.fields).toContainEqual({ field: "line_total", before: 10, after: 15 });

    const { data: count, error: countError } = await fx.supabase.rpc("purchase_document_diff_count", { p_diff: data });
    expect(countError).toBeNull();
    // 1 header field + 1 removed line + 1 added line + 2 modified fields = 5
    expect(count).toBe(5);
  });
});

describe("save_purchase_document_review_corrections", () => {
  it("is non-preparer-only: the preparer cannot review-correct their own submission (GA004)", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    await expect(
      saveReviewCorrectionsRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId, // the preparer
        expectedVersion: ready.version,
        header: { ...HEADER, vendorId: fx.vendorId, total: 999 },
        lines: [{ ...LINE_A, lineKey: ready.lineKey }],
      })
    ).rejects.toBeInstanceOf(CannotSelfVerifyError);
  });

  it("rejects a non-READY_FOR_VERIFICATION document (still DRAFT)", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    await expect(
      saveReviewCorrectionsRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [LINE_A],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("rejects a stale expected_version", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    await expect(
      saveReviewCorrectionsRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 999,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [{ ...LINE_A, lineKey: ready.lineKey }],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("rejects duplicate line_key values in the submitted payload", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    const dupeKey = ready.lineKey;
    await expect(
      saveReviewCorrectionsRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: ready.version,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [
          { ...LINE_A, lineKey: dupeKey },
          { ...LINE_A, lineKey: dupeKey, vendorSku: "SKU-DUPE" },
        ],
      })
    ).rejects.toThrow();

    // save_purchase_document_draft rejects the same payload shape too (the
    // same validation was added there for consistency).
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const draftDupeKey = randomUUID();
    await expect(
      savePurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: { ...HEADER, vendorId: fx.vendorId },
        lines: [
          { ...LINE_A, lineKey: draftDupeKey },
          { ...LINE_A, lineKey: draftDupeKey, vendorSku: "SKU-DUPE" },
        ],
      })
    ).rejects.toThrow();
  });

  it("a save with a real net change writes exactly one attributed PURCHASE_DOCUMENT_REVIEW_CORRECTED event, matching the submission's own audit_events id", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    const { data: submittedEvent } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .single();

    await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 90 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents).toHaveLength(1);
    expect(correctedEvents![0].actor_app_user_id).toBe(fx.lockedEmployeeAppUserId); // the actual saving manager, never inferred
    const afterState = correctedEvents![0].after_state as { submissionAuditEventId: string; headerChanges: unknown[] };
    expect(afterState.submissionAuditEventId).toBe(submittedEvent!.id);
    // Postgres jsonb_build_object on a `numeric` column yields a JSON
    // number, not a string -- before/after are real numbers here.
    expect(afterState.headerChanges).toContainEqual({ field: "total", before: 100, after: 90 });
  });

  it("a save with no real net change writes no REVIEW_CORRECTED event", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 100 }, // identical to submitted
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents).toHaveLength(0);
  });

  it("worked example: Manager B $42 -> $40, Manager C $40 -> $42 -- reviewEditCount=2, finalCorrectionCount=0, no verified-with-corrections notification, but both reviewer edits remain in audit history", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 42 });

    const afterB = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId, // Manager B
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 40 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });

    const managerC = await ensureThirdManager(); // a third real app_user in the SAME org, distinct from the preparer and Manager B

    await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: managerC, // Manager C
      expectedVersion: afterB.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 42 }, // back to submitted value
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents).toHaveLength(2); // both reviewer edits remain, individually attributed
    expect(correctedEvents!.map((e) => e.actor_app_user_id).sort()).toEqual([fx.lockedEmployeeAppUserId, managerC].sort());

    const { data: current } = await fx.supabase.from("purchase_documents").select("version").eq("id", ready.purchaseDocumentId).single();
    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: current!.version as number,
    });
    expect(verified.verifiedAt).toBeTruthy();

    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { finalCorrectionCount: number; reviewEditCount: number };
    expect(state.finalCorrectionCount).toBe(0); // net submitted -> final is unchanged
    expect(state.reviewEditCount).toBe(2); // both attempts still counted as review activity

    const { data: notifications } = await fx.supabase
      .from("user_notifications")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("type", "PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS");
    expect(notifications).toHaveLength(0); // finalCorrectionCount=0 -> no notification, despite reviewEditCount=2
  });
});

/** A third, distinct manager app_user in the SAME organization as the rest
 * of the fixtures -- needed for the B/C worked example above, where two
 * DIFFERENT reviewers (neither of them the preparer) edit the same
 * revision in sequence. Idempotent like the rest of testFixtures.ts. */
async function ensureThirdManager(): Promise<string> {
  const { data: existing } = await fx.supabase.from("employees").select("id").eq("organization_id", fx.organizationId).eq("employee_code", "TEST-RPC-REVIEWER-C").maybeSingle();
  let employeeId = existing?.id as string | undefined;
  if (!employeeId) {
    const { data: inserted, error } = await fx.supabase
      .from("employees")
      .insert({
        organization_id: fx.organizationId,
        first_name: "TestReviewerC",
        last_name: "TestFixture",
        employee_code: "TEST-RPC-REVIEWER-C",
        default_station_id: fx.stationId,
        auto_resolve_station: true,
        can_change_station: false,
        status: "active",
      })
      .select("id")
      .single();
    if (error) throw error;
    employeeId = inserted.id as string;
  }

  const { data: existingAppUser } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();
  if (existingAppUser) return existingAppUser.id as string;

  const pinPepper = process.env.PIN_PEPPER;
  if (!pinPepper) throw new Error("PIN_PEPPER is not set");
  const { hashPinForStorage, hashPinLookup } = await import("@/app/lib/auth/pin");
  const { data: inserted, error } = await fx.supabase
    .from("app_users")
    .insert({
      organization_id: fx.organizationId,
      employee_id: employeeId,
      pin_lookup_hash: hashPinLookup("555555", pinPepper),
      pin_hash: await hashPinForStorage("555555"),
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return inserted.id as string;
}

describe("return_purchase_document_to_draft: restores the submitted snapshot, discarding reviewer edits", () => {
  it("business fields and lines revert to the latest SUBMITTED snapshot, not the reviewer's in-progress edits, and line_key is preserved", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, total: 55, documentNumber: "REVIEWER-EDITED" },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "Reviewer's edit" }],
    });

    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected.version,
      reason: "Discarding reviewer changes, restoring submitted",
    });
    expect(returned.status).toBe("DRAFT");

    const { data: row } = await fx.supabase.from("purchase_documents").select("total, document_number").eq("id", ready.purchaseDocumentId).single();
    expect(Number(row!.total)).toBe(100); // the ORIGINALLY SUBMITTED value, not the reviewer's 55
    expect(row!.document_number).not.toBe("REVIEWER-EDITED");

    const { data: lines } = await fx.supabase
      .from("purchase_document_lines")
      .select("line_key, description")
      .eq("purchase_document_id", ready.purchaseDocumentId);
    expect(lines).toHaveLength(1);
    expect(lines![0].line_key).toBe(ready.lineKey); // stable line_key preserved through restoration
    expect(lines![0].description).not.toBe("Reviewer's edit"); // restored to the submitted description
  });
});

describe("raw READY_FOR_VERIFICATION mutation still requires a sanctioned RPC (the capability flag is not a blanket loosening)", () => {
  it("a raw header UPDATE outside either save_purchase_document_review_corrections or return_purchase_document_to_draft is still GA003", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    const { error } = await fx.supabase.from("purchase_documents").update({ total: 1 }).eq("id", ready.purchaseDocumentId);
    expect(error?.code).toBe("GA003");
  });

  it("a raw line INSERT is still GA003", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    const { error } = await fx.supabase.from("purchase_document_lines").insert({
      organization_id: fx.organizationId,
      purchase_document_id: ready.purchaseDocumentId,
      line_number: 99,
      description: "sneaky",
    });
    expect(error?.code).toBe("GA003");
  });
});

describe("initiate_purchase_document_amendment", () => {
  it("rejects amending a non-VERIFIED document (GA002)", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    await expect(
      initiateAmendmentRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        reason: "test",
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("creates a new DRAFT revision sharing revision_group_id, pointing previous_revision_id at the row it amends, with the initiator as its preparer", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 200 });

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId, // a different manager than the original preparer
      reason: "Total was transcribed incorrectly",
    });
    expect(amendment.revisionNumber).toBe(2);

    const { data: row } = await fx.supabase
      .from("purchase_documents")
      .select("status, revision_group_id, previous_revision_id, created_by_app_user_id, total, amendment_reason")
      .eq("id", amendment.purchaseDocumentId)
      .single();
    expect(row!.status).toBe("DRAFT");
    expect(row!.revision_group_id).toBe(verified.revisionGroupId);
    expect(row!.previous_revision_id).toBe(verified.purchaseDocumentId);
    expect(row!.created_by_app_user_id).toBe(fx.lockedEmployeeAppUserId); // preparer = amendment initiator, not the original uploader
    expect(Number(row!.total)).toBe(200); // copied forward from the revision being amended
    expect(row!.amendment_reason).toBe("Total was transcribed incorrectly");

    // The new revision's own preparer (lockedEmployee) can now edit it as
    // an ordinary draft -- generalized created_by_app_user_id identity in
    // action.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 175 },
      lines: [LINE_A],
    });
    expect(saved.version).toBe(2);
  });

  it("currentVerifiedRevision stays Rev 1 while Rev 2 is DRAFT/READY, both via the SQL function and via the receiving queue", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 300 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test",
    });

    const { data: currentVerifiedId } = await fx.supabase.rpc("current_verified_purchase_document_revision_id", {
      p_organization_id: fx.organizationId,
      p_revision_group_id: verified.revisionGroupId,
    });
    expect(currentVerifiedId).toBe(verified.purchaseDocumentId); // still Rev 1

    const queue = await getReceivingQueue(fx.organizationId);
    const row = queue.find((q) => q.documentId === verified.sourceDocumentId);
    expect(row).toBeTruthy();
    expect(row!.purchaseDocumentId).toBe(amendment.purchaseDocumentId); // effective = the open Rev 2 draft
    expect(row!.revisionNumber).toBe(2);
    expect(row!.currentVerifiedRevisionNumber).toBe(1);
    expect(row!.isAmendmentInProgress).toBe(true);
    expect(row!.status).toBe("DRAFT");

    // Exactly one queue row exists for this business document, never two.
    expect(queue.filter((q) => q.documentId === verified.sourceDocumentId)).toHaveLength(1);
  });

  it("once Rev 2 is itself verified, currentVerifiedRevision becomes Rev 2 and the queue shows it as VERIFIED · CURRENT, not an amendment in progress", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 400 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test",
    });
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 350 },
      lines: [LINE_A],
    });
    const submitted = await submitReady({
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: saved.version,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId, // a different manager than Rev 2's own preparer
      expectedVersion: submitted.version,
    });

    const { data: currentVerifiedId } = await fx.supabase.rpc("current_verified_purchase_document_revision_id", {
      p_organization_id: fx.organizationId,
      p_revision_group_id: verified.revisionGroupId,
    });
    expect(currentVerifiedId).toBe(amendment.purchaseDocumentId);

    const queue = await getReceivingQueue(fx.organizationId);
    const row = queue.find((q) => q.documentId === verified.sourceDocumentId);
    expect(row!.purchaseDocumentId).toBe(amendment.purchaseDocumentId);
    expect(row!.status).toBe("VERIFIED");
    expect(row!.revisionNumber).toBe(2);
    expect(row!.currentVerifiedRevisionNumber).toBe(2);
    expect(row!.isAmendmentInProgress).toBe(false);
  });

  it("two concurrent amendment initiations on the same verified revision -- exactly one succeeds", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 500 });

    const attempt = () =>
      initiateAmendmentRpc(fx.supabase, {
        purchaseDocumentId: verified.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        reason: "concurrent attempt",
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const { count } = await fx.supabase
      .from("purchase_documents")
      .select("id", { count: "exact", head: true })
      .eq("revision_group_id", verified.revisionGroupId)
      .neq("id", verified.purchaseDocumentId);
    expect(count).toBe(1); // only one Rev 2 row was ever created
  });

  it("a raw insert with a previous_revision_id that mismatches organization/group/source is rejected by the composite FK, not just RPC-level care", async () => {
    const verifiedA = await createVerifiedRevisionOneDocument({ total: 10 });
    const verifiedB = await createVerifiedRevisionOneDocument({ total: 20 }); // a different revision family entirely

    const { error } = await fx.supabase.from("purchase_documents").insert({
      id: randomUUID(),
      organization_id: fx.organizationId,
      source_document_id: verifiedA.sourceDocumentId,
      vendor_id: fx.vendorId,
      document_type: "INVOICE",
      status: "DRAFT",
      created_by_app_user_id: fx.lockedEmployeeAppUserId,
      revision_group_id: verifiedA.revisionGroupId, // group A ...
      revision_number: 2,
      previous_revision_id: verifiedB.purchaseDocumentId, // ... but previous_revision_id points into group B
    });
    expect(error).toBeTruthy(); // composite FK violation -- structurally impossible, not merely unvalidated
  });

  it("duplicate detection ignores siblings in the same revision group (an amendment carrying forward the same vendor/type/number is never its own duplicate)", async () => {
    const documentNumber = `AMEND-DUP-${randomUUID().slice(0, 8)}`;
    const verified = await createVerifiedRevisionOneDocument({ documentNumber, total: 60 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test",
    });

    const matches = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
      excludeRevisionGroupId: verified.revisionGroupId,
    });
    expect(matches.map((m) => m.purchaseDocumentId)).not.toContain(verified.purchaseDocumentId);
    expect(matches.map((m) => m.purchaseDocumentId)).not.toContain(amendment.purchaseDocumentId);
  });
});

describe("verify_purchase_document: exact submissionAuditEventId cycle grouping across return -> resubmit", () => {
  it("a REVIEW_CORRECTED event from a returned (discarded) cycle is never aggregated into the resubmitted cycle's reviewEditCount", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    // Cycle 1: a reviewer makes a correction, then a different manager
    // returns it to draft (discarding that correction, per return
    // semantics -- restores the submitted snapshot).
    const corrected1 = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, total: 90 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });
    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected1.version,
      reason: "please double check the total",
    });

    // Preparer resubmits unchanged -- a NEW SUBMITTED event/id.
    const submitted2 = await submitReady({
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: returned.version,
    });

    // Cycle 2: verify with zero reviewer corrections this time.
    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted2.version,
    });
    expect(verified.verifiedAt).toBeTruthy();

    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { reviewEditCount: number; submissionAuditEventId: string };
    expect(state.reviewEditCount).toBe(0); // cycle 1's correction must not leak into cycle 2's count
    expect(state.submissionAuditEventId).not.toBe(null);

    // Both REVIEW_CORRECTED (cycle 1, discarded) and SUBMITTED (both
    // cycles) events remain in the permanent audit trail regardless.
    const { data: allCorrected } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(allCorrected).toHaveLength(1); // cycle 1's correction is retained as history, just not counted toward cycle 2
  });
});

describe("verify_purchase_document: notification recipient deduplication", () => {
  it("when the original uploader and the previous revision's verifier are the same person, only one PURCHASE_DOCUMENT_AMENDMENT_VERIFIED notification is created for them", async () => {
    // Rev 1: prepared by changeableEmployee, verified by lockedEmployee.
    const verified = await createVerifiedRevisionOneDocument({ total: 120 });

    // Amendment (Rev 2) is initiated and verified by lockedEmployee too --
    // the SAME person as Rev 1's verifier AND (since Rev 2's preparer is
    // the amendment initiator) not its own preparer, so a different
    // manager must actually verify it.
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test",
    });
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, total: 130 },
      lines: [LINE_A],
    });
    const submitted = await submitReady({
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: saved.version,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId, // original Rev 1 uploader, distinct from Rev 2's own preparer
      expectedVersion: submitted.version,
    });

    const { data: notifications } = await fx.supabase
      .from("user_notifications")
      .select("recipient_app_user_id")
      .eq("entity_id", amendment.purchaseDocumentId)
      .eq("type", "PURCHASE_DOCUMENT_AMENDMENT_VERIFIED");
    // Recipients would naively be [uploader=changeableEmployee,
    // previousVerifier=lockedEmployee] -- both distinct here, so both get
    // one notification each, never a duplicate for either.
    expect(notifications!.map((n) => n.recipient_app_user_id).sort()).toEqual(
      [fx.changeableEmployeeAppUserId, fx.lockedEmployeeAppUserId].sort()
    );
    expect(new Set(notifications!.map((n) => n.recipient_app_user_id)).size).toBe(notifications!.length); // no duplicate recipient rows
  });
});

describe("verify_purchase_document: atomic save-and-verify (regression for the browser 'unsaved edits silently discarded' bug)", () => {
  it("reviewer's unsaved local edit is persisted and verified atomically -- VERIFIED reflects the edit, REVIEW_CORRECTED records OLD -> CORRECTED, finalCorrectionCount and the notification both reflect it", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });
    // Confirm the persisted (pre-verify) state really is "OLD" -- the
    // reviewer's browser never called Save Corrections.
    const { data: preLine } = await fx.supabase.from("purchase_document_lines").select("description").eq("purchase_document_id", ready.purchaseDocumentId).single();
    expect(preLine!.description).toBe(LINE_A.description); // still whatever was submitted, not yet corrected

    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: ready.total },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "CORRECTED" }],
    });
    expect(verified.verifiedAt).toBeTruthy();

    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", ready.purchaseDocumentId).single();
    expect(row!.status).toBe("VERIFIED");

    const { data: postLine } = await fx.supabase.from("purchase_document_lines").select("description").eq("purchase_document_id", ready.purchaseDocumentId).single();
    expect(postLine!.description).toBe("CORRECTED"); // never the stale pre-click value

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents).toHaveLength(1);
    expect(correctedEvents![0].actor_app_user_id).toBe(fx.lockedEmployeeAppUserId); // the actual verifying reviewer
    const diff = correctedEvents![0].after_state as { lineChanges: { kind: string; fields: { field: string; before: string; after: string }[] }[] };
    const modified = diff.lineChanges.find((c) => c.kind === "modified")!;
    expect(modified.fields).toContainEqual({ field: "description", before: LINE_A.description, after: "CORRECTED" });

    const { data: verifiedEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .single();
    const state = verifiedEvent!.after_state as { finalCorrectionCount: number; reviewEditCount: number };
    expect(state.finalCorrectionCount).toBeGreaterThan(0);
    expect(state.reviewEditCount).toBeGreaterThan(0);

    const { data: notifications } = await fx.supabase
      .from("user_notifications")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("type", "PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS");
    expect(notifications!.length).toBeGreaterThan(0);
  });

  it("reviewer already saved via Save Corrections, then Verify with the identical current payload -- no duplicate REVIEW_CORRECTED event", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: ready.total },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "ALREADY SAVED" }],
    });

    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected.version,
      // Identical to what was just saved -- the UI always sends current
      // state, which here happens to equal the already-persisted state.
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: ready.total },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "ALREADY SAVED" }],
    });

    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents).toHaveLength(1); // only the explicit Save Corrections event -- verify added nothing
  });

  it("stale version: a second atomic verify using an outdated expected_version is rejected and never overwrites the first verify's values", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 500 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "First Verifier" }],
    });
    expect(verified.verifiedAt).toBeTruthy();

    // A second, stale attempt against the original (now outdated)
    // expected_version -- must be rejected, never silently reapplied.
    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: ready.version,
        header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 999 },
        lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "Second Attempt" }],
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const { data: row } = await fx.supabase.from("purchase_documents").select("total, status").eq("id", ready.purchaseDocumentId).single();
    expect(Number(row!.total)).toBe(500);
    expect(row!.status).toBe("VERIFIED");
  });

  it("rejects duplicate line_key values in the atomic verify payload", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    const dupeKey = randomUUID();
    await expect(
      verifyPurchaseDocumentRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: ready.version,
        header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: ready.total },
        lines: [
          { ...LINE_A, lineKey: dupeKey },
          { ...LINE_A, lineKey: dupeKey, vendorSku: "SKU-DUPE" },
        ],
      })
    ).rejects.toThrow();
  });

  it("verify still works normally (no header/lines payload) when the reviewer has no unsaved changes", async () => {
    const ready = await createReadyForVerificationDocumentWithLine();
    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
    });
    expect(verified.verifiedAt).toBeTruthy();
  });
});

describe("atomic submit + return-to-draft + atomic resubmit + verify -- return-flow regression under the new atomic paths", () => {
  it("return-to-draft snapshot restoration continues to work exactly as designed after an atomic submit, and a subsequent atomic resubmit + verify completes cleanly", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const lineKey = randomUUID();
    // Pre-establish lineKey with the SAME content the atomic submits below
    // use ("Submitted Value" never changes across this test) so the
    // completion gate's classification stays CONFIRMED, never STALE --
    // the staleness trigger (20260811100037) fires on genuine content
    // changes by design, which is correct: a line whose description
    // changes really does need re-classification before it can be
    // submitted again under the new completion gate. This test's own
    // subject is line_key/status stability across return-to-draft and
    // resubmit, not content-change-without-reclassification.
    await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "ATOMIC-RETURN-FLOW" },
      lines: [{ ...LINE_A, lineKey, description: "Submitted Value" }],
    });
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, draft.purchaseDocumentId);

    const submittedA = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 2,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "ATOMIC-RETURN-FLOW" },
      lines: [{ ...LINE_A, lineKey, description: "Submitted Value" }],
    });

    const returned = await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submittedA.version,
      reason: "please recheck",
    });
    expect(returned.status).toBe("DRAFT");

    const { data: restoredRow } = await fx.supabase.from("purchase_documents").select("document_number").eq("id", draft.purchaseDocumentId).single();
    expect(restoredRow!.document_number).toBe("ATOMIC-RETURN-FLOW"); // restored exactly what was atomically submitted

    const { data: restoredLines } = await fx.supabase.from("purchase_document_lines").select("line_key, description").eq("purchase_document_id", draft.purchaseDocumentId);
    expect(restoredLines![0].line_key).toBe(lineKey); // stable line_key survives the atomic-submit -> return round trip
    expect(restoredLines![0].description).toBe("Submitted Value");

    const submittedB = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: returned.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "ATOMIC-RETURN-FLOW" },
      lines: [{ ...LINE_A, lineKey, description: "Submitted Value" }],
    });
    expect(submittedB.status).toBe("READY_FOR_VERIFICATION");

    const verified = await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submittedB.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: "ATOMIC-RETURN-FLOW" },
      lines: [{ ...LINE_A, lineKey, description: "Submitted Value" }],
    });
    expect(verified.verifiedAt).toBeTruthy();

    const { data: finalRow } = await fx.supabase.from("purchase_documents").select("status").eq("id", draft.purchaseDocumentId).single();
    expect(finalRow!.status).toBe("VERIFIED");
  });
});

describe("2A.2.1 RPCs: zero inventory or payment-side effects", () => {
  it("save_purchase_document_review_corrections, return_purchase_document_to_draft, and initiate_purchase_document_amendment never touch inventory_movements", async () => {
    const { count: before } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });

    const ready = await createReadyForVerificationDocumentWithLine({ total: 70 });
    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, total: 65 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey }],
    });
    await returnPurchaseDocumentToDraftRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected.version,
    });

    const verified = await createVerifiedRevisionOneDocument({ total: 80 });
    await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test",
    });

    const { count: after } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });
    expect(after).toBe(before); // no inventory or payment-side effects from any 2A.2.1 RPC (this milestone has no payment table yet)
  });
});

describe("discard_purchase_document_draft", () => {
  it("the original DRAFT (revision 1) can be discarded without a reason, and disappears from the queue and duplicate detection", async () => {
    const documentNumber = `DISCARD-REV1-${randomUUID().slice(0, 8)}`;
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber },
      lines: [LINE_A],
    });

    // Present in the queue and in duplicate detection before discard.
    const beforeQueue = await getReceivingQueue(fx.organizationId);
    expect(beforeQueue.some((q) => q.documentId === documentId)).toBe(true);
    const beforeDuplicates = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    expect(beforeDuplicates.map((d) => d.purchaseDocumentId)).toContain(draft.purchaseDocumentId);

    const discarded = await discardPurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: saved.version,
    });
    expect(discarded.status).toBe("DISCARDED");

    const { data: row } = await fx.supabase
      .from("purchase_documents")
      .select("status, discarded_by_app_user_id, discarded_at, discard_reason")
      .eq("id", draft.purchaseDocumentId)
      .single();
    expect(row!.status).toBe("DISCARDED");
    expect(row!.discarded_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect(row!.discarded_at).toBeTruthy();
    expect(row!.discard_reason).toBeNull();

    // Row, lines, and source document are preserved -- never hard-deleted.
    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("id").eq("purchase_document_id", draft.purchaseDocumentId);
    expect(lines!.length).toBeGreaterThan(0);
    const { data: sourceDoc } = await fx.supabase.from("documents").select("id").eq("id", documentId).maybeSingle();
    expect(sourceDoc).toBeTruthy();

    const { data: auditEvent } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, after_state")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_DISCARDED")
      .single();
    expect(auditEvent!.actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);

    // Hidden from the queue afterward -- never falls back to a stale
    // "Needs Review" state.
    const afterQueue = await getReceivingQueue(fx.organizationId);
    expect(afterQueue.some((q) => q.documentId === documentId)).toBe(false);

    // Ignored by duplicate detection -- a discarded accidental draft must
    // not keep warning users forever.
    const afterDuplicates = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      documentType: "INVOICE",
      documentNumber,
    });
    expect(afterDuplicates.map((d) => d.purchaseDocumentId)).not.toContain(draft.purchaseDocumentId);
  });

  it("a READY_FOR_VERIFICATION document cannot be discarded directly -- it must be withdrawn to DRAFT first", async () => {
    const ready = await createReadyForVerificationDocument();
    await expect(
      discardPurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: ready.version,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", ready.purchaseDocumentId).single();
    expect(row!.status).toBe("READY_FOR_VERIFICATION"); // unchanged
  });

  it("a VERIFIED document can never be discarded", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 40 });
    await expect(
      discardPurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: verified.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 3,
      })
    ).rejects.toThrow();

    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", verified.purchaseDocumentId).single();
    expect(row!.status).toBe("VERIFIED");
  });

  it("only the preparer may discard their own draft", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    await expect(
      discardPurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });

  it("an amendment (revision > 1) requires a reason to discard", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 90 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "test amendment",
    });

    await expect(
      discardPurchaseDocumentDraftRpc(fx.supabase, {
        purchaseDocumentId: amendment.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toThrow();

    const discarded = await discardPurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      reason: "Changed my mind about this correction",
    });
    expect(discarded.status).toBe("DISCARDED");
  });

  it("discarding Rev 2 leaves Rev 1 as the current verified AND effective workflow revision, does not block a new amendment, and the next amendment is Rev 3 (never reusing Rev 2)", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 200 });
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "first attempt",
    });
    expect(amendment.revisionNumber).toBe(2);

    await discardPurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 1,
      reason: "wrong approach",
    });

    const { data: currentVerifiedId } = await fx.supabase.rpc("current_verified_purchase_document_revision_id", {
      p_organization_id: fx.organizationId,
      p_revision_group_id: verified.revisionGroupId,
    });
    expect(currentVerifiedId).toBe(verified.purchaseDocumentId); // Rev 1 still current verified

    const queue = await getReceivingQueue(fx.organizationId);
    const row = queue.find((q) => q.documentId === verified.sourceDocumentId);
    expect(row).toBeTruthy();
    expect(row!.purchaseDocumentId).toBe(verified.purchaseDocumentId); // effective workflow revision falls back to Rev 1
    expect(row!.status).toBe("VERIFIED");
    expect(row!.revisionNumber).toBe(1);
    expect(row!.isAmendmentInProgress).toBe(false);

    // A discarded Rev 2 does not block a new amendment attempt.
    const secondAmendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      reason: "second attempt",
    });
    expect(secondAmendment.revisionNumber).toBe(3); // never reuses 2

    const { data: allRevisions } = await fx.supabase
      .from("purchase_documents")
      .select("revision_number, status")
      .eq("revision_group_id", verified.revisionGroupId)
      .order("revision_number");
    expect(allRevisions!.map((r) => [r.revision_number, r.status])).toEqual([
      [1, "VERIFIED"],
      [2, "DISCARDED"],
      [3, "DRAFT"],
    ]);
  });

  it("discarding never touches inventory_movements", async () => {
    const { count: before } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });

    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    await discardPurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    const { count: after } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });
    expect(after).toBe(before);
  });
});

describe("withdraw_purchase_document_submission", () => {
  it("the uploader/preparer can withdraw their own READY submission back to DRAFT", async () => {
    const ready = await createReadyForVerificationDocument();
    const withdrawn = await withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: ready.version,
      reason: "need to fix a typo",
    });
    expect(withdrawn.status).toBe("DRAFT");

    const { data: auditEvent } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, after_state")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMISSION_WITHDRAWN")
      .single();
    expect(auditEvent!.actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect((auditEvent!.after_state as { reason: string }).reason).toBe("need to fix a typo");

    // The preparer can now freely edit it again, exactly like any DRAFT.
    const saved = await savePurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: withdrawn.version,
      header: { ...HEADER, vendorId: fx.vendorId },
      lines: [LINE_A],
    });
    expect(saved.version).toBe(withdrawn.version + 1);
  });

  it("another manager cannot withdraw someone else's submission", async () => {
    const ready = await createReadyForVerificationDocument();
    await expect(
      withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId, // not the preparer
        expectedVersion: ready.version,
      })
    ).rejects.toBeInstanceOf(NotPreparerError);

    const { data: row } = await fx.supabase.from("purchase_documents").select("status").eq("id", ready.purchaseDocumentId).single();
    expect(row!.status).toBe("READY_FOR_VERIFICATION"); // unchanged
  });

  it("restores the latest SUBMITTED snapshot after reviewer edits -- reviewer corrections are discarded from the restored draft but preserved permanently in audit history", async () => {
    const ready = await createReadyForVerificationDocumentWithLine({ total: 100 });

    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: ready.version,
      header: { ...HEADER, vendorId: fx.vendorId, documentNumber: ready.documentNumber, total: 55 },
      lines: [{ ...LINE_A, lineKey: ready.lineKey, description: "Reviewer's edit" }],
    });

    const withdrawn = await withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: corrected.version,
    });
    expect(withdrawn.status).toBe("DRAFT");

    const { data: row } = await fx.supabase.from("purchase_documents").select("total").eq("id", ready.purchaseDocumentId).single();
    expect(Number(row!.total)).toBe(100); // the ORIGINALLY SUBMITTED value, not the reviewer's 55 -- never silently promoted

    const { data: lines } = await fx.supabase.from("purchase_document_lines").select("description").eq("purchase_document_id", ready.purchaseDocumentId);
    expect(lines![0].description).not.toBe("Reviewer's edit");

    // The reviewer's correction event is still there, permanently, as
    // discarded review history.
    const { data: correctedEvents } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_id", ready.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
    expect(correctedEvents!.length).toBeGreaterThan(0);
  });

  it("stale version is rejected", async () => {
    const ready = await createReadyForVerificationDocument();
    await expect(
      withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
        purchaseDocumentId: ready.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 999,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("never touches inventory_movements", async () => {
    const { count: before } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });
    const ready = await createReadyForVerificationDocument();
    await withdrawPurchaseDocumentSubmissionRpc(fx.supabase, {
      purchaseDocumentId: ready.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: ready.version,
    });
    const { count: after } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true });
    expect(after).toBe(before);
  });
});

describe("archive_document", () => {
  it("an upload with no purchase_document ever created can be archived by its uploader, and disappears from the queue", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);

    const beforeQueue = await getReceivingQueue(fx.organizationId);
    expect(beforeQueue.some((q) => q.documentId === documentId)).toBe(true);

    const archived = await archiveDocumentRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(archived.archivedAt).toBeTruthy();

    // documents itself is fully append-only -- the archive fact lives in
    // the separate document_archives table.
    const { data: row } = await fx.supabase.from("document_archives").select("archived_at, archived_by_app_user_id").eq("document_id", documentId).single();
    expect(row!.archived_at).toBeTruthy();
    expect(row!.archived_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);

    const { data: auditEvent } = await fx.supabase
      .from("audit_events")
      .select("id")
      .eq("entity_type", "document")
      .eq("entity_id", documentId)
      .eq("action", "DOCUMENT_ARCHIVED")
      .maybeSingle();
    expect(auditEvent).toBeTruthy();

    const afterQueue = await getReceivingQueue(fx.organizationId);
    expect(afterQueue.some((q) => q.documentId === documentId)).toBe(false);
  });

  it("an upload whose only purchase_document was discarded can also be archived", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    const draft = await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    await discardPurchaseDocumentDraftRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    const archived = await archiveDocumentRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(archived.archivedAt).toBeTruthy();
  });

  it("an upload backing an active (non-discarded) purchase_document workflow cannot be archived", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    await initializePurchaseDocumentDraftRpc(fx.supabase, {
      documentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await expect(
      archiveDocumentRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toBeInstanceOf(StaleVersionError);

    const { data: row } = await fx.supabase.from("document_archives").select("document_id").eq("document_id", documentId).maybeSingle();
    expect(row).toBeNull();
  });

  it("a VERIFIED document's upload can never be archived", async () => {
    const verified = await createVerifiedRevisionOneDocument({ total: 30 });
    await expect(
      archiveDocumentRpc(fx.supabase, {
        documentId: verified.sourceDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("only the uploader may archive their own upload", async () => {
    const { documentId } = await createSucceededDocument(fx.changeableEmployeeAppUserId);
    await expect(
      archiveDocumentRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});
