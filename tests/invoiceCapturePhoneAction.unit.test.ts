import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Covers the phone-facing Server Actions
// (app/actions/invoiceCapturePhone.ts) -- the ONLY functions a phone
// browser ever calls, deliberately NOT gated by requireManagerOrAdmin()
// (Part 6). Every call is authorized purely by hashing the supplied bearer
// token and looking up its digest; a phone can never supply an
// organization_id/session_id directly, and a malformed token must never
// even reach the database.

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import {
  getCapturePhoneStatusAction,
  beginCaptureUploadAction,
  finishCaptureUploadAction,
} from "@/app/actions/invoiceCapturePhone";

const VALID_TOKEN = "A".repeat(43);
const MALFORMED_TOKEN = "not-a-real-token";

function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

function buildFakeServiceClient(opts: {
  rpcImpl?: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  sessionOrgId?: string | null;
  downloadBytes?: Uint8Array;
  downloadError?: unknown;
  createSignedUploadUrlError?: unknown;
}) {
  const rpc = vi.fn(opts.rpcImpl ?? (async () => ({ data: null, error: null })));

  const single = vi.fn(async () => ({ data: opts.sessionOrgId ? { organization_id: opts.sessionOrgId } : null }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  const createSignedUploadUrl = vi.fn(async () =>
    opts.createSignedUploadUrlError
      ? { data: null, error: opts.createSignedUploadUrlError }
      : { data: { signedUrl: "https://example.test/upload", token: "upload-tok" }, error: null }
  );
  const download = vi.fn(async () =>
    opts.downloadError
      ? { data: null, error: opts.downloadError }
      : { data: { arrayBuffer: async () => (opts.downloadBytes ?? jpegBytes()).buffer }, error: null }
  );
  const storageFrom = vi.fn(() => ({ createSignedUploadUrl, download }));

  return { client: { rpc, from, storage: { from: storageFrom } }, rpc, from, createSignedUploadUrl, download };
}

beforeEach(() => {
  getServiceRoleClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCapturePhoneStatusAction -- token-authorized, no auth gate", () => {
  it("rejects a malformed token before ever touching the database", async () => {
    const { client, rpc } = buildFakeServiceClient({});
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await getCapturePhoneStatusAction(MALFORMED_TOKEN);

    expect(result).toEqual({ ok: false, reason: "invalid", message: "This capture link is not valid." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hashes the raw token before sending it to the RPC -- the raw token itself is never sent", async () => {
    const { client, rpc } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    await getCapturePhoneStatusAction(VALID_TOKEN);

    expect(rpc).toHaveBeenCalledWith("get_invoice_capture_session_phone", { p_token_digest: expect.any(String) });
    const sentDigest = rpc.mock.calls[0][1].p_token_digest as string;
    expect(sentDigest).not.toBe(VALID_TOKEN);
    expect(sentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps an unknown digest (no matching row) to a generic invalid response, not a database error", async () => {
    const { client } = buildFakeServiceClient({ rpcImpl: async () => ({ data: [], error: null }) });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await getCapturePhoneStatusAction(VALID_TOKEN);
    expect(result).toEqual({ ok: false, reason: "invalid", message: "This capture link is not valid." });
  });

  it("returns the session status for a valid token", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "RECEIVED" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await getCapturePhoneStatusAction(VALID_TOKEN);
    expect(result).toEqual({ ok: true, status: "RECEIVED" });
  });
});

describe("beginCaptureUploadAction -- narrow, scoped upload slot only", () => {
  it("rejects a malformed token before ever touching the database", async () => {
    const { client, rpc } = buildFakeServiceClient({});
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(MALFORMED_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "invalid", message: "This capture link is not valid." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a declared content type outside the phone-capture allowlist (e.g. application/pdf), never mints an upload URL", async () => {
    const { client, createSignedUploadUrl } = buildFakeServiceClient({});
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(VALID_TOKEN, "application/pdf");
    expect(result).toEqual({ ok: false, reason: "invalid_file_type", message: "Unsupported photo format." });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("maps GA059 (invalid token) from the RPC to an invalid response", async () => {
    const { client } = buildFakeServiceClient({ rpcImpl: async () => ({ data: null, error: { code: "GA059", message: "not found" } }) });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "invalid", message: "This capture link is not valid." });
  });

  it("maps GA060 (expired) from the RPC to an expired response", async () => {
    const { client } = buildFakeServiceClient({ rpcImpl: async () => ({ data: null, error: { code: "GA060", message: "expired" } }) });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "expired", message: "This capture link has expired." });
  });

  it("maps GA061 (session not WAITING, e.g. cancelled/already-received) to an unavailable response", async () => {
    const { client } = buildFakeServiceClient({ rpcImpl: async () => ({ data: null, error: { code: "GA061", message: "not available" } }) });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "unavailable", message: "This capture session is no longer available." });
  });

  it("mints an upload URL scoped to the exact expected staging path for a valid, waiting session", async () => {
    const { client, createSignedUploadUrl } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_organization_id: "org-1" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await beginCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("org/org-1/captures/session-1/page-1.jpg");
    }
    expect(createSignedUploadUrl).toHaveBeenCalledWith("org/org-1/captures/session-1/page-1.jpg");
  });

  it("always requests page 1 -- single-page V1 scope, never a client-supplied page number", async () => {
    const { client, rpc } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_organization_id: "org-1" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    await beginCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(rpc).toHaveBeenCalledWith("begin_invoice_capture_upload", { p_token_digest: expect.any(String), p_page_number: 1 });
  });
});

describe("finishCaptureUploadAction -- server-authoritative re-validation, never trusts declared type alone", () => {
  it("rejects a malformed token before ever touching the database", async () => {
    const { client } = buildFakeServiceClient({});
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(MALFORMED_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "invalid", message: "This capture link is not valid." });
  });

  it("rejects when the session has expired since begin", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "EXPIRED" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "expired", message: "This capture link has expired." });
  });

  it("rejects when the session is no longer WAITING (e.g. cancelled or already received)", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "CANCELLED" }], error: null }),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "unavailable", message: "This capture session is no longer available." });
  });

  it("rejects an empty uploaded file", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null }),
      sessionOrgId: "org-1",
      downloadBytes: new Uint8Array(0),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "invalid_file_type", message: "The photo appears to be empty. Try again." });
  });

  it("rejects bytes that fail magic-byte sniffing even though the declared content type was image/jpeg -- never trusts the client's declared type alone", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async () => ({ data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null }),
      sessionOrgId: "org-1",
      downloadBytes: new TextEncoder().encode("this is not actually a jpeg"),
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toMatchObject({ ok: false, reason: "invalid_file_type" });
  });

  it("re-derives the storage path server-side from the session's own org, never trusting a client-supplied path", async () => {
    const { client, rpc } = buildFakeServiceClient({
      rpcImpl: async (name: string) => {
        if (name === "get_invoice_capture_session_phone") return { data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null };
        return { data: [{ out_session_id: "session-1", out_already_recorded: false }], error: null };
      },
      sessionOrgId: "org-1",
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: true });

    const recordCall = rpc.mock.calls.find((call) => call[0] === "record_invoice_capture_page");
    expect(recordCall).toBeDefined();
    expect(recordCall![1]).toMatchObject({ p_storage_path: "org/org-1/captures/session-1/page-1.jpg", p_content_type: "image/jpeg" });
  });

  it("computes and forwards the SHA-256 content hash of the downloaded bytes", async () => {
    const { client, rpc } = buildFakeServiceClient({
      rpcImpl: async (name: string) => {
        if (name === "get_invoice_capture_session_phone") return { data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null };
        return { data: [{ out_session_id: "session-1", out_already_recorded: false }], error: null };
      },
      sessionOrgId: "org-1",
    });
    getServiceRoleClientMock.mockReturnValue(client);

    await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");

    const recordCall = rpc.mock.calls.find((call) => call[0] === "record_invoice_capture_page");
    const hash = recordCall![1].p_content_hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps GA059/GA060/GA061 from record_invoice_capture_page the same way begin does", async () => {
    const { client } = buildFakeServiceClient({
      rpcImpl: async (name: string) => {
        if (name === "get_invoice_capture_session_phone") return { data: [{ out_session_id: "session-1", out_status: "WAITING" }], error: null };
        return { data: null, error: { code: "GA061", message: "not available" } };
      },
      sessionOrgId: "org-1",
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await finishCaptureUploadAction(VALID_TOKEN, "image/jpeg");
    expect(result).toEqual({ ok: false, reason: "unavailable", message: "This capture session is no longer available." });
  });
});
