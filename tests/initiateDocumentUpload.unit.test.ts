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
