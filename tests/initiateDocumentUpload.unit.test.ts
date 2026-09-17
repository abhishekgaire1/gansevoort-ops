import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Covers the vendor-first/type-first
// intake validation added to initiateDocumentUpload in Milestone 2A.2.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { initiateDocumentUpload } from "@/app/actions/documentUpload";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

const INPUT = {
  filename: "invoice.pdf",
  declaredContentType: "application/pdf",
  vendorId: "vendor-1",
  declaredDocumentType: "INVOICE" as const,
};

function createChainable(result: { data: unknown; error: unknown }): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => Promise.resolve(result).then(resolve, reject);
      }
      return () => proxy;
    },
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

function buildFakeServiceClient(opts: { vendorActive: boolean }) {
  const from = vi.fn((table: string) => {
    if (table === "vendors") {
      return createChainable({ data: opts.vendorActive ? { id: "vendor-1" } : null, error: null });
    }
    if (table === "documents") {
      return createChainable({ data: null, error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
  const createSignedUploadUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://example.test/upload", token: "tok" }, error: null });
  const storageFrom = vi.fn(() => ({ createSignedUploadUrl }));
  return { client: { from, storage: { from: storageFrom } }, createSignedUploadUrl };
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("initiateDocumentUpload -- vendor-first intake", () => {
  it("rejects when the vendor is not active/not in the organization, without minting a signed upload URL", async () => {
    const { client, createSignedUploadUrl } = buildFakeServiceClient({ vendorActive: false });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await initiateDocumentUpload(INPUT);

    expect(result).toEqual({ ok: false, reason: "invalid_vendor", message: "Select an active vendor before uploading." });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("proceeds to mint a signed upload URL once the vendor is confirmed active", async () => {
    const { client, createSignedUploadUrl } = buildFakeServiceClient({ vendorActive: true });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await initiateDocumentUpload(INPUT);

    expect(result.ok).toBe(true);
    expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated callers before checking the vendor", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await initiateDocumentUpload(INPUT);
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
  });
});

const SHA = "a".repeat(64);

function buildDuplicateAwareClient(opts: { documents: unknown[]; purchaseDocuments: unknown[]; archives: unknown[] }) {
  const from = vi.fn((table: string) => {
    if (table === "vendors") return createChainable({ data: { id: "vendor-1" }, error: null });
    if (table === "documents") return createChainable({ data: opts.documents, error: null });
    if (table === "purchase_documents") return createChainable({ data: opts.purchaseDocuments, error: null });
    if (table === "document_archives") return createChainable({ data: opts.archives, error: null });
    throw new Error(`unexpected table ${table}`);
  });
  const createSignedUploadUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://example.test/upload", token: "tok" }, error: null });
  return { client: { from, storage: { from: vi.fn(() => ({ createSignedUploadUrl })) } } };
}

describe("initiateDocumentUpload -- possible-duplicate state awareness", () => {
  it("tags a discarded prior upload as DISCARDED (the reported case), not the same as a live duplicate", async () => {
    const { client } = buildDuplicateAwareClient({
      documents: [{ id: "doc-old", created_at: "2026-09-17T10:25:06Z" }],
      purchaseDocuments: [{ source_document_id: "doc-old", status: "DISCARDED" }],
      archives: [],
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await initiateDocumentUpload({ ...INPUT, clientComputedSha256: SHA });
    expect(result.ok).toBe(true);
    expect(result.ok && result.possibleDuplicate).toEqual({ documentId: "doc-old", uploadedAt: "2026-09-17T10:25:06Z", priorState: "DISCARDED" });
  });

  it("surfaces the most significant prior -- a VERIFIED older upload is not hidden behind a newer discarded one", async () => {
    const { client } = buildDuplicateAwareClient({
      documents: [
        { id: "doc-new", created_at: "2026-09-17T12:00:00Z" },
        { id: "doc-old", created_at: "2026-09-10T09:00:00Z" },
      ],
      purchaseDocuments: [
        { source_document_id: "doc-new", status: "DISCARDED" },
        { source_document_id: "doc-old", status: "VERIFIED" },
      ],
      archives: [],
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await initiateDocumentUpload({ ...INPUT, clientComputedSha256: SHA });
    expect(result.ok && result.possibleDuplicate?.priorState).toBe("VERIFIED");
    expect(result.ok && result.possibleDuplicate?.documentId).toBe("doc-old");
  });

  it("returns no possible duplicate when the file has never been uploaded", async () => {
    const { client } = buildDuplicateAwareClient({ documents: [], purchaseDocuments: [], archives: [] });
    getServiceRoleClientMock.mockReturnValue(client);
    const result = await initiateDocumentUpload({ ...INPUT, clientComputedSha256: SHA });
    expect(result.ok && result.possibleDuplicate).toBeNull();
  });
});
