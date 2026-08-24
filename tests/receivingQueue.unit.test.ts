import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database -- fakes supabase.rpc()/from() directly.
// Proves: filters are forwarded to search_receiving_queue verbatim (the
// actual filtering-before-limit behavior lives in that SQL function and is
// proven by tests/receivingQueue.rpc.test.ts against a real database), and
// that this file's own remaining job -- mapping RPC rows + resolving
// display names -- is correct.

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { getReceivingQueue } from "@/app/lib/documents/receivingQueue";

function fakeClient(opts: {
  queueRows: Record<string, unknown>[];
  vendors?: Record<string, unknown>[];
  appUsers?: Record<string, unknown>[];
  postingStatusRows?: Record<string, unknown>[];
}) {
  // The second param widens vi.fn's inferred call signature so
  // rpc.mock.calls[i][1] (the RPC params object) type-checks at the
  // assertion sites below, even though this fake dispatches by name alone.
  const rpc = vi.fn((fnName: string, params?: Record<string, unknown>) => {
    void params;
    if (fnName === "search_receiving_queue") return Promise.resolve({ data: opts.queueRows, error: null });
    if (fnName === "get_purchase_documents_inventory_posting_status") return Promise.resolve({ data: opts.postingStatusRows ?? [], error: null });
    throw new Error(`unexpected rpc ${fnName}`);
  });
  const from = vi.fn((table: string) => {
    if (table === "vendors") {
      return { select: () => ({ in: () => Promise.resolve({ data: opts.vendors ?? [] }) }) };
    }
    if (table === "app_users") {
      return { select: () => ({ in: () => Promise.resolve({ data: opts.appUsers ?? [] }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { rpc, from };
}

beforeEach(() => {
  getServiceRoleClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getReceivingQueue -- forwards filters to search_receiving_queue verbatim", () => {
  it("passes every filter through with the expected defaults", async () => {
    const { rpc, from } = fakeClient({ queueRows: [] });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    await getReceivingQueue("org-1", {
      vendorId: "vendor-1",
      uploadedByAppUserId: "user-1",
      status: "READY_FOR_VERIFICATION",
      documentType: "RECEIPT",
      dateType: "business",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-10",
      q: "839291",
    });

    expect(rpc).toHaveBeenCalledWith("search_receiving_queue", {
      p_organization_id: "org-1",
      p_vendor_id: "vendor-1",
      p_uploaded_by_app_user_id: "user-1",
      p_status: "READY_FOR_VERIFICATION",
      p_document_type: "RECEIPT",
      p_date_type: "business",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-10",
      p_query: "839291",
      p_limit: 200,
    });
  });

  it("defaults dateType to 'uploaded' and every optional filter to null when omitted", async () => {
    const { rpc, from } = fakeClient({ queueRows: [] });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    await getReceivingQueue("org-1");

    expect(rpc).toHaveBeenCalledWith("search_receiving_queue", {
      p_organization_id: "org-1",
      p_vendor_id: null,
      p_uploaded_by_app_user_id: null,
      p_status: null,
      p_document_type: null,
      p_date_type: "uploaded",
      p_date_from: null,
      p_date_to: null,
      p_query: null,
      p_limit: 200,
    });
  });

  it("throws (never silently returns an empty queue) if the RPC errors -- a manager acting on a silently-empty queue is worse than a visible, retryable failure", async () => {
    // Changed in 2A.4: the old swallow-into-[] behavior made a transient
    // DB error (e.g. a statement timeout under load) read as "there are
    // no documents", with no signal anywhere -- a real defect observed
    // against real Postgres, not a hypothetical.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    getServiceRoleClientMock.mockReturnValue({ rpc, from: vi.fn() });

    await expect(getReceivingQueue("org-1")).rejects.toThrow(/search_receiving_queue failed: boom/);
  });
});

describe("getReceivingQueue -- mapping RPC rows to ReceivingQueueItem", () => {
  it("prefers the effective (purchase_documents) vendor/type and shows the declared one only when it diverges and a purchase_document exists", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [
        {
          out_document_id: "doc-1",
          out_original_filename: "invoice.pdf",
          out_content_type: "application/pdf",
          out_created_at: "2026-08-12T00:00:00Z",
          out_uploaded_by_app_user_id: "user-1",
          out_purchase_document_id: "pd-1",
          out_effective_vendor_id: "vendor-corrected",
          out_effective_document_type: "INVOICE",
          out_declared_vendor_id: "vendor-original",
          out_declared_document_type: "RECEIPT",
          out_document_number: "839291",
          out_document_date: "2026-08-10",
          out_status: "DRAFT",
          out_verified_by_app_user_id: null,
          out_revision_number: null,
          out_current_verified_revision_number: null,
          out_created_by_app_user_id: "user-1",
        },
      ],
      vendors: [
        { id: "vendor-corrected", name: "Baldor" },
        { id: "vendor-original", name: "Wrong Vendor" },
      ],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result).toEqual([
      {
        documentId: "doc-1",
        purchaseDocumentId: "pd-1",
        originalFilename: "invoice.pdf",
        createdAt: "2026-08-12T00:00:00Z",
        uploadedByAppUserId: "user-1",
        uploadedByName: "Ana Manager",
        vendorId: "vendor-corrected",
        vendorName: "Baldor",
        documentType: "INVOICE",
        documentNumber: "839291",
        documentDate: "2026-08-10",
        originalVendorName: "Wrong Vendor",
        originalDocumentType: "RECEIPT",
        verifiedByName: null,
        status: "DRAFT",
        revisionNumber: null,
        currentVerifiedRevisionNumber: null,
        isAmendmentInProgress: false,
        createdByAppUserId: "user-1",
        createdByName: "Ana Manager",
        postingStatus: null,
      },
    ]);
  });

  it("never shows an 'originally selected' note when no purchase_document exists yet, even if declared fields are set", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [
        {
          out_document_id: "doc-2",
          out_original_filename: "receipt.jpg",
          out_content_type: "image/jpeg",
          out_created_at: "2026-08-12T00:00:00Z",
          out_uploaded_by_app_user_id: "user-1",
          out_purchase_document_id: null,
          out_effective_vendor_id: "vendor-original",
          out_effective_document_type: "RECEIPT",
          out_declared_vendor_id: "vendor-original",
          out_declared_document_type: "RECEIPT",
          out_document_number: null,
          out_document_date: null,
          out_status: "NEEDS_REVIEW",
          out_verified_by_app_user_id: null,
          out_revision_number: null,
          out_current_verified_revision_number: null,
        },
      ],
      vendors: [{ id: "vendor-original", name: "Baldor" }],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result[0].originalVendorName).toBeNull();
    expect(result[0].originalDocumentType).toBeNull();
  });
});

describe("getReceivingQueue -- revision/amendment fields", () => {
  function amendmentRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      out_document_id: "doc-3",
      out_original_filename: "invoice.pdf",
      out_content_type: "application/pdf",
      out_created_at: "2026-08-12T00:00:00Z",
      out_uploaded_by_app_user_id: "user-1",
      out_purchase_document_id: "pd-3",
      out_effective_vendor_id: "vendor-1",
      out_effective_document_type: "INVOICE",
      out_declared_vendor_id: "vendor-1",
      out_declared_document_type: "INVOICE",
      out_document_number: "839291",
      out_document_date: "2026-08-10",
      out_status: "DRAFT",
      out_verified_by_app_user_id: null,
      out_revision_number: 2,
      out_current_verified_revision_number: 1,
      ...overrides,
    };
  }

  it("marks an open (DRAFT/READY) revision-2+ row as isAmendmentInProgress when a current verified revision exists", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [amendmentRow()],
      vendors: [{ id: "vendor-1", name: "Baldor" }],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result[0].revisionNumber).toBe(2);
    expect(result[0].currentVerifiedRevisionNumber).toBe(1);
    expect(result[0].isAmendmentInProgress).toBe(true);
  });

  it("is not an amendment once the row itself is VERIFIED, even at revision > 1 -- it becomes the new current-verified revision instead", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [amendmentRow({ out_status: "VERIFIED", out_revision_number: 2, out_current_verified_revision_number: 2 })],
      vendors: [{ id: "vendor-1", name: "Baldor" }],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result[0].isAmendmentInProgress).toBe(false);
  });

  it("is not an amendment at revision 1, even while still DRAFT/READY (a first-time document, nothing to amend)", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [amendmentRow({ out_revision_number: 1, out_current_verified_revision_number: null })],
      vendors: [{ id: "vendor-1", name: "Baldor" }],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result[0].isAmendmentInProgress).toBe(false);
  });
});

// V1 Ready-to-Post queue fix (Section 12) -- the queue must be able to
// show Ready-to-Post/Partially Posted/Posted for VERIFIED rows via ONE
// batched RPC call, never one call per row.
describe("getReceivingQueue -- batched inventory posting status", () => {
  function verifiedRow(id: string, purchaseDocumentId: string) {
    return {
      out_document_id: id,
      out_original_filename: "invoice.pdf",
      out_content_type: "application/pdf",
      out_created_at: "2026-08-12T00:00:00Z",
      out_uploaded_by_app_user_id: "user-1",
      out_purchase_document_id: purchaseDocumentId,
      out_effective_vendor_id: "vendor-1",
      out_effective_document_type: "INVOICE",
      out_declared_vendor_id: "vendor-1",
      out_declared_document_type: "INVOICE",
      out_document_number: `INV-${id}`,
      out_document_date: "2026-08-10",
      out_status: "VERIFIED",
      out_verified_by_app_user_id: "user-2",
      out_revision_number: 1,
      out_current_verified_revision_number: 1,
      out_created_by_app_user_id: "user-1",
    };
  }

  it("never calls the posting-status RPC at all when the queue has zero VERIFIED rows", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [
        { out_document_id: "d1", out_original_filename: "f", out_content_type: "application/pdf", out_created_at: "2026-08-12T00:00:00Z", out_uploaded_by_app_user_id: "user-1", out_purchase_document_id: "pd-1", out_effective_vendor_id: null, out_effective_document_type: null, out_declared_vendor_id: null, out_declared_document_type: null, out_document_number: null, out_document_date: null, out_status: "DRAFT", out_verified_by_app_user_id: null, out_revision_number: null, out_current_verified_revision_number: null, out_created_by_app_user_id: "user-1" },
      ],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(rpc).toHaveBeenCalledTimes(1); // search_receiving_queue only
    expect(result[0].postingStatus).toBeNull();
  });

  it("fetches posting status for every VERIFIED row in exactly ONE batched RPC call, regardless of how many rows", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [verifiedRow("d1", "pd-1"), verifiedRow("d2", "pd-2"), verifiedRow("d3", "pd-3")],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }, { id: "user-2", employees: { first_name: "Bo", last_name: "Verifier" } }],
      vendors: [{ id: "vendor-1", name: "Baldor" }],
      postingStatusRows: [
        { out_purchase_document_id: "pd-1", out_status: "NOT_POSTED", out_required_line_count: 5, out_posted_line_count: 0 },
        { out_purchase_document_id: "pd-2", out_status: "PARTIALLY_POSTED", out_required_line_count: 5, out_posted_line_count: 2 },
        { out_purchase_document_id: "pd-3", out_status: "POSTED", out_required_line_count: 5, out_posted_line_count: 5 },
      ],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    const postingCalls = rpc.mock.calls.filter((c) => c[0] === "get_purchase_documents_inventory_posting_status");
    expect(postingCalls).toHaveLength(1);
    expect(postingCalls[0][1]).toEqual({ p_organization_id: "org-1", p_purchase_document_ids: ["pd-1", "pd-2", "pd-3"] });

    expect(result.find((r) => r.purchaseDocumentId === "pd-1")?.postingStatus).toEqual({ status: "NOT_POSTED", requiredLineCount: 5 });
    expect(result.find((r) => r.purchaseDocumentId === "pd-2")?.postingStatus).toEqual({ status: "PARTIALLY_POSTED", requiredLineCount: 5 });
    expect(result.find((r) => r.purchaseDocumentId === "pd-3")?.postingStatus).toEqual({ status: "POSTED", requiredLineCount: 5 });
  });

  it("a VERIFIED row the batched RPC returns nothing for gets postingStatus null rather than crashing the queue", async () => {
    const { rpc, from } = fakeClient({
      queueRows: [verifiedRow("d1", "pd-1")],
      appUsers: [{ id: "user-1", employees: { first_name: "Ana", last_name: "Manager" } }, { id: "user-2", employees: { first_name: "Bo", last_name: "Verifier" } }],
      vendors: [{ id: "vendor-1", name: "Baldor" }],
      postingStatusRows: [],
    });
    getServiceRoleClientMock.mockReturnValue({ rpc, from });

    const result = await getReceivingQueue("org-1");

    expect(result[0].postingStatus).toBeNull();
  });
});
