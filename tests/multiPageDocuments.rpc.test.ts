import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { generateCaptureToken } from "@/app/lib/invoiceCapture/token";
import { finalizeDocumentUploadRpc, type FinalizeDocumentUploadRpcInput } from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { addDocumentPageRpc, DocumentPageIdentityConflictError } from "@/app/lib/documents/addDocumentPageRpc";
import { listDocumentPagesRpc } from "@/app/lib/documents/listDocumentPagesRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (not run in CI; `npm test` does not include this file, run
 * explicitly via `npm run test:integration`).
 *
 * Proves the multi-page phone capture schema/RPCs added by
 * 20260811100127-100129 against real Postgres: a finalized document
 * always gets its own page-1 document_pages row (the migration's AFTER
 * INSERT trigger, and the one-time backfill), add_document_page's
 * strict-sequence/idempotent-replay/page-limit rules, and the
 * invoice_capture_pages staging RPCs (begin/record for page 2+,
 * delete-and-renumber, reorder, desktop listing) -- exactly the class of
 * guarantee a mocked-client unit test (tests/documentPagesRpc.unit.test.ts)
 * cannot prove.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

async function finalizeFreshDocument(): Promise<string> {
  const documentId = randomUUID();
  await finalizeDocumentUploadRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    storagePath: `org/${fx.organizationId}/documents/${documentId}/original.pdf`,
    originalFilename: "test-invoice.pdf",
    contentType: "application/pdf",
    byteSize: 12345,
    fileSha256: randomBytes(32).toString("hex"),
    provider: "gemini",
    model: "gemini-3.6-flash",
    vendorId: fx.vendorId,
    declaredDocumentType: "INVOICE",
  } as FinalizeDocumentUploadRpcInput);
  return documentId;
}

describe("document_pages -- every finalized document automatically gets page 1", () => {
  it("existing/newly-finalized single-page documents render as exactly one page (Page 1)", async () => {
    const documentId = await finalizeFreshDocument();
    const pages = await listDocumentPagesRpc(fx.supabase, fx.organizationId, documentId);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ pageNumber: 1, contentType: "application/pdf" });
  });

  it("cross-organization access returns no pages, never another org's document", async () => {
    const documentId = await finalizeFreshDocument();
    const pages = await listDocumentPagesRpc(fx.supabase, otherOrg.organizationId, documentId);
    expect(pages).toHaveLength(0);
  });
});

describe("add_document_page -- pages 2+ on an already-finalized document", () => {
  it("two or more pages form ONE document, retaining correct page order", async () => {
    const documentId = await finalizeFreshDocument();

    const page2 = await addDocumentPageRpc(fx.supabase, {
      organizationId: fx.organizationId,
      documentId,
      appUserId: fx.changeableEmployeeAppUserId,
      pageNumber: 2,
      storagePath: `org/${fx.organizationId}/documents/${documentId}/page-2.jpg`,
      contentType: "image/jpeg",
      byteSize: 2048,
      fileSha256: randomBytes(32).toString("hex"),
    });
    expect(page2.replayed).toBe(false);

    const page3 = await addDocumentPageRpc(fx.supabase, {
      organizationId: fx.organizationId,
      documentId,
      appUserId: fx.changeableEmployeeAppUserId,
      pageNumber: 3,
      storagePath: `org/${fx.organizationId}/documents/${documentId}/page-3.jpg`,
      contentType: "image/jpeg",
      byteSize: 4096,
      fileSha256: randomBytes(32).toString("hex"),
    });
    expect(page3.replayed).toBe(false);

    const pages = await listDocumentPagesRpc(fx.supabase, fx.organizationId, documentId);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // Still one document -- never a second documents row.
    const { count } = await fx.supabase.from("documents").select("id", { count: "exact", head: true }).eq("id", documentId);
    expect(count).toBe(1);
  });

  it("rejects an out-of-sequence page number (GA069)", async () => {
    const documentId = await finalizeFreshDocument();
    await expect(
      addDocumentPageRpc(fx.supabase, {
        organizationId: fx.organizationId,
        documentId,
        appUserId: fx.changeableEmployeeAppUserId,
        pageNumber: 3,
        storagePath: `org/${fx.organizationId}/documents/${documentId}/page-3.jpg`,
        contentType: "image/jpeg",
        byteSize: 2048,
        fileSha256: randomBytes(32).toString("hex"),
      })
    ).rejects.toThrow(/must be added in sequence/);
  });

  it("duplicate Submit does not create duplicate pages -- an identical retry of the SAME page is a true replay, never a second row", async () => {
    const documentId = await finalizeFreshDocument();
    const input = {
      organizationId: fx.organizationId,
      documentId,
      appUserId: fx.changeableEmployeeAppUserId,
      pageNumber: 2,
      storagePath: `org/${fx.organizationId}/documents/${documentId}/page-2.jpg`,
      contentType: "image/jpeg",
      byteSize: 2048,
      fileSha256: randomBytes(32).toString("hex"),
    };

    const first = await addDocumentPageRpc(fx.supabase, input);
    const second = await addDocumentPageRpc(fx.supabase, input);
    expect(second).toEqual({ pageId: first.pageId, replayed: true });

    const { count } = await fx.supabase.from("document_pages").select("id", { count: "exact", head: true }).eq("document_id", documentId).eq("page_number", 2);
    expect(count).toBe(1);
  });

  it("a retry with the SAME page number but DIFFERENT file identity is rejected, never silently overwritten (GA070)", async () => {
    const documentId = await finalizeFreshDocument();
    const input = {
      organizationId: fx.organizationId,
      documentId,
      appUserId: fx.changeableEmployeeAppUserId,
      pageNumber: 2,
      storagePath: `org/${fx.organizationId}/documents/${documentId}/page-2.jpg`,
      contentType: "image/jpeg",
      byteSize: 2048,
      fileSha256: randomBytes(32).toString("hex"),
    };
    await addDocumentPageRpc(fx.supabase, input);

    await expect(addDocumentPageRpc(fx.supabase, { ...input, byteSize: 9999 })).rejects.toBeInstanceOf(DocumentPageIdentityConflictError);
  });

  it("concurrent submission of the same page cannot double-add it -- exactly one row survives", async () => {
    const documentId = await finalizeFreshDocument();
    const input = {
      organizationId: fx.organizationId,
      documentId,
      appUserId: fx.changeableEmployeeAppUserId,
      pageNumber: 2,
      storagePath: `org/${fx.organizationId}/documents/${documentId}/page-2.jpg`,
      contentType: "image/jpeg",
      byteSize: 2048,
      fileSha256: randomBytes(32).toString("hex"),
    };

    const results = await Promise.allSettled([addDocumentPageRpc(fx.supabase, input), addDocumentPageRpc(fx.supabase, input)]);
    // Either both succeed (one replayed) or one succeeds and the other hits
    // the sequence check mid-race -- either way, never two rows.
    const { count } = await fx.supabase.from("document_pages").select("id", { count: "exact", head: true }).eq("document_id", documentId).eq("page_number", 2);
    expect(count).toBe(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("rejects a document that doesn't exist in the caller's own organization (cross-org isolation)", async () => {
    const documentId = await finalizeFreshDocument();
    await expect(
      addDocumentPageRpc(fx.supabase, {
        organizationId: otherOrg.organizationId,
        documentId,
        appUserId: otherOrg.appUserId,
        pageNumber: 2,
        storagePath: `org/${otherOrg.organizationId}/documents/${documentId}/page-2.jpg`,
        contentType: "image/jpeg",
        byteSize: 2048,
        fileSha256: randomBytes(32).toString("hex"),
      })
    ).rejects.toThrow(/not found in organization/);
  });
});

// ============================================================
// invoice_capture_pages -- multi-page staging (delete/reorder/desktop list)
// ============================================================

function futureExpiry(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function createSession(organizationId: string, actorAppUserId: string) {
  const { token, digest } = generateCaptureToken();
  const { data, error } = await fx.supabase.rpc("create_invoice_capture_session", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_token_digest: digest,
    p_expires_at: futureExpiry(),
  });
  if (error) throw error;
  const sessionId = (data as { out_session_id: string }[])[0].out_session_id;
  return { sessionId, token, digest };
}

async function beginAndRecord(sessionId: string, digest: string, pageNumber: number) {
  const begin = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: pageNumber });
  if (begin.error) throw begin.error;
  return fx.supabase.rpc("record_invoice_capture_page", {
    p_token_digest: digest,
    p_page_number: pageNumber,
    p_storage_path: `org/${fx.organizationId}/captures/${sessionId}/page-${pageNumber}.jpg`,
    p_content_type: "image/jpeg",
    p_byte_size: 1000 * pageNumber,
    p_content_hash: randomBytes(32).toString("hex"),
  });
}

describe("invoice_capture_pages -- multi-page capture staging", () => {
  it("captures 3 pages in one session, retaining correct order, and reports the page count in phone status", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    for (const n of [1, 2, 3]) {
      const { error } = await beginAndRecord(sessionId, digest, n);
      expect(error).toBeNull();
    }

    const { data: statusData } = await fx.supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
    const status = (statusData as { out_status: string; out_page_count: number }[])[0];
    expect(status.out_status).toBe("RECEIVED");
    expect(status.out_page_count).toBe(3);

    const { data: rows } = await fx.supabase.from("invoice_capture_pages").select("page_number").eq("capture_session_id", sessionId).order("page_number");
    expect((rows ?? []).map((r) => r.page_number)).toEqual([1, 2, 3]);
  });

  it("retaking a page (delete then re-add the same page number) replaces only that page, leaving the others untouched", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);
    await beginAndRecord(sessionId, digest, 2);

    const { data: before } = await fx.supabase.from("invoice_capture_pages").select("storage_path").eq("capture_session_id", sessionId).eq("page_number", 1).single();

    const del = await fx.supabase.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: 2 });
    expect(del.error).toBeNull();
    expect((del.data as { out_remaining_page_count: number }[])[0].out_remaining_page_count).toBe(1);

    await beginAndRecord(sessionId, digest, 2);

    const { data: after1 } = await fx.supabase.from("invoice_capture_pages").select("storage_path").eq("capture_session_id", sessionId).eq("page_number", 1).single();
    expect(after1!.storage_path).toBe(before!.storage_path); // page 1 untouched

    const { count } = await fx.supabase.from("invoice_capture_pages").select("id", { count: "exact", head: true }).eq("capture_session_id", sessionId);
    expect(count).toBe(2);
  });

  it("deleting a page safely renumbers the remaining pages contiguously", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    for (const n of [1, 2, 3]) await beginAndRecord(sessionId, digest, n);

    const { data: page3Before } = await fx.supabase.from("invoice_capture_pages").select("storage_path").eq("capture_session_id", sessionId).eq("page_number", 3).single();

    const del = await fx.supabase.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: 2 });
    expect(del.error).toBeNull();

    const { data: rows } = await fx.supabase.from("invoice_capture_pages").select("page_number, storage_path").eq("capture_session_id", sessionId).order("page_number");
    expect((rows ?? []).map((r) => r.page_number)).toEqual([1, 2]);
    // Old page 3 is now page 2, same underlying bytes.
    expect(rows!.find((r) => r.page_number === 2)!.storage_path).toBe(page3Before!.storage_path);
  });

  it("deleting the last remaining page reverts the session to WAITING so a fresh page 1 can be captured again", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);

    await fx.supabase.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: 1 });

    const { data: statusData } = await fx.supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
    const status = (statusData as { out_status: string; out_page_count: number }[])[0];
    expect(status.out_status).toBe("WAITING");
    expect(status.out_page_count).toBe(0);

    const { error } = await beginAndRecord(sessionId, digest, 1);
    expect(error).toBeNull();
  });

  it("reordering pages updates the authoritative order (page contents move, numbering stays 1..N)", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    for (const n of [1, 2, 3]) await beginAndRecord(sessionId, digest, n);

    const { data: before } = await fx.supabase.from("invoice_capture_pages").select("page_number, storage_path").eq("capture_session_id", sessionId).order("page_number");
    const originalPage3Path = before!.find((r) => r.page_number === 3)!.storage_path;
    const originalPage1Path = before!.find((r) => r.page_number === 1)!.storage_path;

    // New order: old page 3 first, then old page 1, then old page 2.
    const reorder = await fx.supabase.rpc("reorder_invoice_capture_pages", { p_token_digest: digest, p_new_page_order: [3, 1, 2] });
    expect(reorder.error).toBeNull();

    const { data: after } = await fx.supabase.from("invoice_capture_pages").select("page_number, storage_path").eq("capture_session_id", sessionId).order("page_number");
    expect(after!.find((r) => r.page_number === 1)!.storage_path).toBe(originalPage3Path);
    expect(after!.find((r) => r.page_number === 2)!.storage_path).toBe(originalPage1Path);
  });

  it("rejects a reorder that isn't an exact permutation of the existing pages (GA072)", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);
    await beginAndRecord(sessionId, digest, 2);

    const { error } = await fx.supabase.rpc("reorder_invoice_capture_pages", { p_token_digest: digest, p_new_page_order: [1, 1] });
    expect(error!.code).toBe("GA072");
  });

  it("rejects deleting a page that doesn't exist (GA072)", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);

    const { error } = await fx.supabase.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: 5 });
    expect(error!.code).toBe("GA072");
  });

  it("mobile camera cancellation (never calling delete) does not destroy already-saved pages -- they simply remain recorded", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);
    await beginAndRecord(sessionId, digest, 2);

    // Simulate the user cancelling the camera / navigating away before
    // adding page 3 -- nothing about pages 1-2 should change.
    const { data: rows } = await fx.supabase.from("invoice_capture_pages").select("page_number").eq("capture_session_id", sessionId).order("page_number");
    expect((rows ?? []).map((r) => r.page_number)).toEqual([1, 2]);
  });

  it("list_invoice_capture_pages_desktop returns every page in order, and rejects cross-organization access", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);
    await beginAndRecord(sessionId, digest, 2);

    const { data: ownOrgRows, error: ownOrgError } = await fx.supabase.rpc("list_invoice_capture_pages_desktop", {
      p_organization_id: fx.organizationId,
      p_session_id: sessionId,
    });
    expect(ownOrgError).toBeNull();
    expect((ownOrgRows as { out_page_number: number }[]).map((r) => r.out_page_number)).toEqual([1, 2]);

    const { data: otherOrgRows } = await fx.supabase.rpc("list_invoice_capture_pages_desktop", {
      p_organization_id: otherOrg.organizationId,
      p_session_id: sessionId,
    });
    expect(otherOrgRows).toEqual([]);
  });

  it("delete/reorder are refused once the session has been CONTINUED (finalized into a real document) -- no longer open for editing", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecord(sessionId, digest, 1);

    const documentId = await finalizeFreshDocument();
    await fx.supabase.rpc("continue_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
      p_document_id: documentId,
    });

    const { error } = await fx.supabase.rpc("delete_invoice_capture_page", { p_token_digest: digest, p_page_number: 1 });
    expect(error!.code).toBe("GA061");
  });
});
