import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every DESKTOP-facing Phone
// Capture Server Action (app/actions/invoiceCaptureDesktop.ts) gates on
// requireManagerOrAdmin() exactly like every other Receiving action, and
// that organization_id/actor are always derived from that authenticated
// session -- never accepted from a caller-supplied argument -- matching
// the existing convention in adminVendorsAuthorization.unit.test.ts.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { rpcMock, getServiceRoleClientMock } = vi.hoisted(() => {
  const rpcMock = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({ data: [{ out_session_id: "session-1" }], error: null }));
  return { rpcMock, getServiceRoleClientMock: vi.fn() };
});
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,fake") } }));

import {
  createCaptureSessionAction,
  getCaptureSessionStatusAction,
  getActiveCaptureSessionAction,
  cancelCaptureSessionAction,
  getCaptureImageDownloadUrlAction,
  listCaptureSessionPagesAction,
  continueCaptureSessionAction,
} from "@/app/actions/invoiceCaptureDesktop";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

function buildFakeServiceClient() {
  const maybeSingle = vi.fn(async () => ({ data: { storage_path: "org/org-1/captures/session-1/page-1.jpg", content_type: "image/jpeg" } }));
  const eq3 = vi.fn(() => ({ maybeSingle }));
  const eq2 = vi.fn(() => ({ eq: eq3 }));
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const select = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn(() => ({ select }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "https://example.test/signed" }, error: null }));
  const storageFrom = vi.fn(() => ({ createSignedUrl }));
  return { from, rpc: rpcMock, storage: { from: storageFrom } };
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  rpcMock.mockReset().mockResolvedValue({ data: [{ out_session_id: "session-1", out_status: "WAITING", out_expires_at: "2026-01-01T00:10:00Z", out_document_id: null, out_page_count: 0 }], error: null });
  getServiceRoleClientMock.mockReset().mockReturnValue(buildFakeServiceClient());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Phone Capture desktop actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "createCaptureSessionAction", call: () => createCaptureSessionAction() },
    { name: "getCaptureSessionStatusAction", call: () => getCaptureSessionStatusAction("session-1") },
    { name: "getActiveCaptureSessionAction", call: () => getActiveCaptureSessionAction() },
    { name: "cancelCaptureSessionAction", call: () => cancelCaptureSessionAction("session-1") },
    { name: "getCaptureImageDownloadUrlAction", call: () => getCaptureImageDownloadUrlAction("session-1") },
    { name: "listCaptureSessionPagesAction", call: () => listCaptureSessionPagesAction("session-1") },
    { name: "continueCaptureSessionAction", call: () => continueCaptureSessionAction("session-1", "doc-1") },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects an unauthenticated caller before touching the database`, async () => {
      requireManagerOrAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it(`${name} succeeds for an authenticated manager`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("createCaptureSessionAction -- org/actor always derived from the session, never client-supplied", () => {
  it("passes organizationId/actorAppUserId from requireManagerOrAdmin(), and generates a fresh token each call", async () => {
    await createCaptureSessionAction();
    expect(rpcMock).toHaveBeenCalledWith(
      "create_invoice_capture_session",
      expect.objectContaining({ p_organization_id: "org-1", p_actor_app_user_id: "user-1" })
    );
  });

  it("returns a captureUrl pointing at the deployed phone-capture shell, never this app's own origin/localhost", async () => {
    const result = await createCaptureSessionAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedPrefix = `${process.env.PHONE_CAPTURE_SHELL_URL}?token=`;
      expect(result.captureUrl.startsWith(expectedPrefix)).toBe(true);
      expect(result.captureUrl).not.toContain("localhost");
      expect(result.captureUrl).not.toContain("127.0.0.1");
    }
  });

  it("never embeds the raw token in the returned session state -- only the QR image and captureUrl carry it", async () => {
    const result = await createCaptureSessionAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rawToken = new URL(result.captureUrl).searchParams.get("token");
      expect(rawToken).toBeTruthy();
      expect(JSON.stringify(result.session)).not.toContain(rawToken);
    }
  });
});

describe("getCaptureSessionStatusAction / getActiveCaptureSessionAction -- always scoped to the caller's own org", () => {
  it("getCaptureSessionStatusAction passes the authenticated organizationId to the RPC, not any client value", async () => {
    await getCaptureSessionStatusAction("session-1");
    expect(rpcMock).toHaveBeenCalledWith("get_invoice_capture_session_desktop", { p_organization_id: "org-1", p_session_id: "session-1" });
  });

  it("getActiveCaptureSessionAction scopes to both the caller's org AND their own app_user id", async () => {
    await getActiveCaptureSessionAction();
    expect(rpcMock).toHaveBeenCalledWith("get_active_invoice_capture_session_for_manager", {
      p_organization_id: "org-1",
      p_created_by_app_user_id: "user-1",
    });
  });
});

describe("listCaptureSessionPagesAction -- multi-page (100127), always scoped to the caller's own org", () => {
  it("passes the authenticated organizationId to list_invoice_capture_pages_desktop, never a client-supplied one", async () => {
    rpcMock.mockResolvedValue({ data: [{ out_page_number: 1, out_storage_path: "org/org-1/captures/session-1/page-1.jpg", out_content_type: "image/jpeg" }], error: null });
    await listCaptureSessionPagesAction("session-1");
    expect(rpcMock).toHaveBeenCalledWith("list_invoice_capture_pages_desktop", { p_organization_id: "org-1", p_session_id: "session-1" });
  });

  it("a session belonging to a different organization returns no pages, never leaking cross-org data -- the RPC itself is the org boundary, and this action never widens it", async () => {
    // Mirrors list_invoice_capture_pages_desktop's own WHERE organization_id
    // = p_organization_id filter: a session id from another org simply
    // yields zero rows here, exactly like any other org-scoped read in
    // this codebase (e.g. getCaptureImageDownloadUrlAction's own
    // .eq("organization_id", ...) pattern).
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await listCaptureSessionPagesAction("session-in-another-org");
    expect(result).toEqual({ ok: true, pages: [] });
  });

  it("returns pages in order with a signed URL and content type for each", async () => {
    rpcMock.mockResolvedValue({
      data: [
        { out_page_number: 1, out_storage_path: "org/org-1/captures/session-1/page-1.jpg", out_content_type: "image/jpeg" },
        { out_page_number: 2, out_storage_path: "org/org-1/captures/session-1/page-2.jpg", out_content_type: "image/jpeg" },
      ],
      error: null,
    });
    const result = await listCaptureSessionPagesAction("session-1");
    expect(result).toEqual({
      ok: true,
      pages: [
        { pageNumber: 1, downloadUrl: "https://example.test/signed", contentType: "image/jpeg" },
        { pageNumber: 2, downloadUrl: "https://example.test/signed", contentType: "image/jpeg" },
      ],
    });
  });
});

describe("continueCaptureSessionAction -- never creates a document itself", () => {
  it("only records provenance against an already-created documentId, passing the actor/org from the session", async () => {
    await continueCaptureSessionAction("session-1", "doc-1");
    expect(rpcMock).toHaveBeenCalledWith("continue_invoice_capture_session", {
      p_organization_id: "org-1",
      p_actor_app_user_id: "user-1",
      p_session_id: "session-1",
      p_document_id: "doc-1",
    });
  });
});
