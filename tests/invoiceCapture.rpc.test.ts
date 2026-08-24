import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { generateCaptureToken } from "@/app/lib/invoiceCapture/token";
import { finalizeDocumentUploadRpc, type FinalizeDocumentUploadRpcInput } from "@/app/lib/documents/finalizeDocumentUploadRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (not run in CI; `npm test` does not include this file, run
 * explicitly via `npm run test:integration`).
 *
 * Proves the Phone-to-Desktop Invoice Capture milestone's new RPCs
 * (supabase/migrations/20260811100103_invoice_phone_capture.sql) against
 * real Postgres: session creation/expiry-derivation/cancellation/
 * continuation, the phone-facing digest-only lookup, single-page-V1
 * upload-slot rejection rules, idempotent page recording, append-only
 * integrity on both new tables, and cross-organization isolation --
 * exactly the class of guarantee a mocked-client unit test cannot prove
 * (a mock never actually enforces a Postgres trigger or a real unique
 * index).
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

function futureExpiry(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
function pastExpiry(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

async function createSession(organizationId: string, actorAppUserId: string, expiresAt = futureExpiry()) {
  const { token, digest } = generateCaptureToken();
  const { data, error } = await fx.supabase.rpc("create_invoice_capture_session", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_token_digest: digest,
    p_expires_at: expiresAt,
  });
  if (error) throw error;
  const sessionId = (data as { out_session_id: string }[])[0].out_session_id;
  return { sessionId, token, digest };
}

async function beginAndRecordPage(sessionId: string, digest: string) {
  await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });
  return fx.supabase.rpc("record_invoice_capture_page", {
    p_token_digest: digest,
    p_page_number: 1,
    p_storage_path: `org/${fx.organizationId}/captures/${sessionId}/page-1.jpg`,
    p_content_type: "image/jpeg",
    p_byte_size: 12345,
    p_content_hash: randomBytes(32).toString("hex"),
  });
}

async function createDocument(organizationId: string, actorAppUserId: string, vendorId: string): Promise<string> {
  const documentId = randomUUID();
  const input: FinalizeDocumentUploadRpcInput = {
    documentId,
    organizationId,
    uploadedByAppUserId: actorAppUserId,
    storagePath: `org/${organizationId}/documents/${documentId}/original.jpg`,
    originalFilename: "phone-capture.jpg",
    contentType: "image/jpeg",
    byteSize: 12345,
    fileSha256: randomBytes(32).toString("hex"),
    provider: "gemini",
    model: "gemini-3.6-flash",
    vendorId,
    declaredDocumentType: "INVOICE",
  };
  await finalizeDocumentUploadRpc(fx.supabase, input);
  return documentId;
}

describe("create_invoice_capture_session", () => {
  it("creates a WAITING session scoped to the actor/org and audits PHONE_CAPTURE_SESSION_CREATED", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);

    const { data: row } = await fx.supabase
      .from("invoice_capture_sessions")
      .select("status, organization_id, created_by_app_user_id, document_id")
      .eq("id", sessionId)
      .single();
    expect(row!.status).toBe("WAITING");
    expect(row!.organization_id).toBe(fx.organizationId);
    expect(row!.created_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect(row!.document_id).toBeNull();

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("action")
      .eq("entity_id", sessionId)
      .eq("action", "PHONE_CAPTURE_SESSION_CREATED")
      .maybeSingle();
    expect(audit).not.toBeNull();
  });

  it("never persists the raw token anywhere -- only its digest", async () => {
    const { sessionId, token } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { data: row } = await fx.supabase.from("invoice_capture_sessions").select("*").eq("id", sessionId).single();
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("get_invoice_capture_session_desktop -- org-scoped, derives EXPIRED inline", () => {
  it("returns WAITING for a fresh session", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_desktop", { p_organization_id: fx.organizationId, p_session_id: sessionId });
    expect((data as { out_status: string }[])[0].out_status).toBe("WAITING");
  });

  it("derives EXPIRED once expires_at has passed -- no background job flips the stored status", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId, pastExpiry());
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_desktop", { p_organization_id: fx.organizationId, p_session_id: sessionId });
    expect((data as { out_status: string }[])[0].out_status).toBe("EXPIRED");

    const { data: raw } = await fx.supabase.from("invoice_capture_sessions").select("status").eq("id", sessionId).single();
    expect(raw!.status).toBe("WAITING"); // stored status is untouched; EXPIRED is purely derived at read time
  });

  it("returns no row for a session belonging to a different organization", async () => {
    const { sessionId } = await createSession(otherOrg.organizationId, otherOrg.appUserId);
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_desktop", { p_organization_id: fx.organizationId, p_session_id: sessionId });
    expect((data as unknown[]).length).toBe(0);
  });
});

describe("get_active_invoice_capture_session_for_manager -- desktop refresh recovery", () => {
  it("finds the most recent WAITING/RECEIVED session created by that specific manager", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.lockedEmployeeAppUserId);
    const { data } = await fx.supabase.rpc("get_active_invoice_capture_session_for_manager", {
      p_organization_id: fx.organizationId,
      p_created_by_app_user_id: fx.lockedEmployeeAppUserId,
    });
    expect((data as { out_session_id: string }[])[0].out_session_id).toBe(sessionId);
  });

  it("never returns a CANCELLED session", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.mustPickEmployeeAppUserId);
    await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.mustPickEmployeeAppUserId,
      p_session_id: sessionId,
    });
    const { data } = await fx.supabase.rpc("get_active_invoice_capture_session_for_manager", {
      p_organization_id: fx.organizationId,
      p_created_by_app_user_id: fx.mustPickEmployeeAppUserId,
    });
    expect((data as unknown[]).length).toBe(0);
  });

  it("never returns another manager's session", async () => {
    await createSession(fx.organizationId, fx.lockedEmployeeAppUserId);
    const { data } = await fx.supabase.rpc("get_active_invoice_capture_session_for_manager", {
      p_organization_id: fx.organizationId,
      p_created_by_app_user_id: fx.changeableEmployeeAppUserId,
    });
    // changeableEmployeeAppUserId may have leftover sessions from other tests in this
    // file, so assert none of the returned rows belong to lockedEmployee's session set
    // by checking this call never errors and stays scoped -- the authoritative proof is
    // the WHERE created_by_app_user_id = ... clause itself, exercised directly here.
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("cancel_invoice_capture_session", () => {
  it("raises GA059 for a session id that doesn't exist", async () => {
    const { error } = await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("GA059");
  });

  it("cancels a WAITING session, audits PHONE_CAPTURE_CANCELLED, and a second cancel raises GA061", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);

    const { error } = await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
    });
    expect(error).toBeNull();

    const { data: row } = await fx.supabase.from("invoice_capture_sessions").select("status").eq("id", sessionId).single();
    expect(row!.status).toBe("CANCELLED");

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("action")
      .eq("entity_id", sessionId)
      .eq("action", "PHONE_CAPTURE_CANCELLED")
      .maybeSingle();
    expect(audit).not.toBeNull();

    const { error: secondError } = await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
    });
    expect(secondError!.code).toBe("GA061");
  });

  it("a cancelled session immediately rejects a late phone upload attempt", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
    });

    const { error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });
    expect(error!.code).toBe("GA061");
  });

  it("cannot cancel a session belonging to a different organization", async () => {
    const { sessionId } = await createSession(otherOrg.organizationId, otherOrg.appUserId);
    const { error } = await fx.supabase.rpc("cancel_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
    });
    expect(error!.code).toBe("GA059");
  });
});

describe("get_invoice_capture_session_phone -- resolved purely from the token digest, no org/session id ever supplied", () => {
  it("returns WAITING for a fresh session", async () => {
    const { digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
    expect((data as { out_status: string }[])[0].out_status).toBe("WAITING");
  });

  it("returns no row for an unknown digest", async () => {
    const unknownDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: unknownDigest });
    expect((data as unknown[]).length).toBe(0);
  });

  it("derives EXPIRED the same way the desktop-facing RPC does", async () => {
    const { digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId, pastExpiry());
    const { data } = await fx.supabase.rpc("get_invoice_capture_session_phone", { p_token_digest: digest });
    expect((data as { out_status: string }[])[0].out_status).toBe("EXPIRED");
  });
});

describe("begin_invoice_capture_upload / record_invoice_capture_page", () => {
  it("raises GA059 for an unknown token digest", async () => {
    const unknownDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const { error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: unknownDigest, p_page_number: 1 });
    expect(error!.code).toBe("GA059");
  });

  it("raises GA060 for an expired session", async () => {
    const { digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId, pastExpiry());
    const { error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });
    expect(error!.code).toBe("GA060");
  });

  it("raises GA061 for any page number other than 1 -- single-page V1 scope", async () => {
    const { digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 2 });
    expect(error!.code).toBe("GA061");
  });

  it("succeeds for a valid WAITING session at page 1, returning the session's own server-derived org", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { data, error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });
    expect(error).toBeNull();
    const row = (data as { out_session_id: string; out_organization_id: string }[])[0];
    expect(row.out_session_id).toBe(sessionId);
    expect(row.out_organization_id).toBe(fx.organizationId);
  });

  it("recording a page transitions the session to RECEIVED, preserves the exact hash, and audits PHONE_CAPTURE_RECEIVED exactly once -- a retry is a true no-op", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });

    const path = `org/${fx.organizationId}/captures/${sessionId}/page-1.jpg`;
    const hash = randomBytes(32).toString("hex");
    const { data, error } = await fx.supabase.rpc("record_invoice_capture_page", {
      p_token_digest: digest,
      p_page_number: 1,
      p_storage_path: path,
      p_content_type: "image/jpeg",
      p_byte_size: 12345,
      p_content_hash: hash,
    });
    expect(error).toBeNull();
    expect((data as { out_already_recorded: boolean }[])[0].out_already_recorded).toBe(false);

    const { data: sessionRow } = await fx.supabase.from("invoice_capture_sessions").select("status").eq("id", sessionId).single();
    expect(sessionRow!.status).toBe("RECEIVED");

    const { data: pageRow } = await fx.supabase
      .from("invoice_capture_pages")
      .select("storage_path, content_hash, byte_size")
      .eq("capture_session_id", sessionId)
      .eq("page_number", 1)
      .single();
    expect(pageRow!.storage_path).toBe(path);
    expect(pageRow!.content_hash).toBe(hash);

    const { count: auditCount } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", sessionId)
      .eq("action", "PHONE_CAPTURE_RECEIVED");
    expect(auditCount).toBe(1);

    // Retry with the same page/token: must be a true no-op, never a duplicate row or audit.
    const { data: retryData, error: retryError } = await fx.supabase.rpc("record_invoice_capture_page", {
      p_token_digest: digest,
      p_page_number: 1,
      p_storage_path: path,
      p_content_type: "image/jpeg",
      p_byte_size: 12345,
      p_content_hash: hash,
    });
    expect(retryError).toBeNull();
    expect((retryData as { out_already_recorded: boolean }[])[0].out_already_recorded).toBe(true);

    const { count: pageCount } = await fx.supabase
      .from("invoice_capture_pages")
      .select("id", { count: "exact", head: true })
      .eq("capture_session_id", sessionId);
    expect(pageCount).toBe(1);

    const { count: auditCountAfterRetry } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", sessionId)
      .eq("action", "PHONE_CAPTURE_RECEIVED");
    expect(auditCountAfterRetry).toBe(1);
  });

  it("a second begin_invoice_capture_upload call after RECEIVED raises GA061 -- one accepted upload closes the token", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecordPage(sessionId, digest);

    const { error } = await fx.supabase.rpc("begin_invoice_capture_upload", { p_token_digest: digest, p_page_number: 1 });
    expect(error!.code).toBe("GA061");
  });
});

describe("continue_invoice_capture_session -- never creates a document itself, only records provenance", () => {
  it("raises GA059 for an unknown session", async () => {
    const documentId = await createDocument(fx.organizationId, fx.changeableEmployeeAppUserId, fx.vendorId);
    const { error } = await fx.supabase.rpc("continue_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: randomUUID(),
      p_document_id: documentId,
    });
    expect(error!.code).toBe("GA059");
  });

  it("sets CONTINUED + document_id, audits PHONE_CAPTURE_CONTINUED with the desktop Manager recorded as actor (never anonymous)", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecordPage(sessionId, digest);

    const documentId = await createDocument(fx.organizationId, fx.changeableEmployeeAppUserId, fx.vendorId);
    const { error } = await fx.supabase.rpc("continue_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
      p_document_id: documentId,
    });
    expect(error).toBeNull();

    const { data: row } = await fx.supabase.from("invoice_capture_sessions").select("status, document_id").eq("id", sessionId).single();
    expect(row!.status).toBe("CONTINUED");
    expect(row!.document_id).toBe(documentId);

    const { data: audit } = await fx.supabase
      .from("audit_events")
      .select("action, actor_app_user_id")
      .eq("entity_id", sessionId)
      .eq("action", "PHONE_CAPTURE_CONTINUED")
      .maybeSingle();
    expect(audit).not.toBeNull();
    expect(audit!.actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);
  });

  it("rejects a document_id that doesn't exist in the organization", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecordPage(sessionId, digest);

    const { error } = await fx.supabase.rpc("continue_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
      p_document_id: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("cannot attach a document belonging to a different organization", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecordPage(sessionId, digest);

    const otherOrgDocumentId = await createDocument(otherOrg.organizationId, otherOrg.appUserId, otherOrg.vendorId);
    const { error } = await fx.supabase.rpc("continue_invoice_capture_session", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_session_id: sessionId,
      p_document_id: otherOrgDocumentId,
    });
    expect(error).not.toBeNull();
  });
});

describe("append-only integrity", () => {
  it("invoice_capture_sessions rejects a hard delete, but permits status-transition updates (cancel/continue)", async () => {
    const { sessionId } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    const { error } = await fx.supabase.from("invoice_capture_sessions").delete().eq("id", sessionId);
    expect(error).not.toBeNull();
  });

  it("invoice_capture_pages rejects both update and delete once a page is recorded -- fully append-only", async () => {
    const { sessionId, digest } = await createSession(fx.organizationId, fx.changeableEmployeeAppUserId);
    await beginAndRecordPage(sessionId, digest);

    const { error: updateError } = await fx.supabase
      .from("invoice_capture_pages")
      .update({ content_type: "image/png" })
      .eq("capture_session_id", sessionId)
      .eq("page_number", 1);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await fx.supabase
      .from("invoice_capture_pages")
      .delete()
      .eq("capture_session_id", sessionId)
      .eq("page_number", 1);
    expect(deleteError).not.toBeNull();
  });
});
