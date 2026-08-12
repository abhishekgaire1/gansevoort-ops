import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  finalizeDocumentUploadRpc,
  DocumentIdentityConflictError,
  type FinalizeDocumentUploadRpcInput,
} from "@/app/lib/documents/finalizeDocumentUploadRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * This is exactly the class of test the mocked unit tests
 * (tests/finalizeDocumentUploadRpc.unit.test.ts, tests/documentUploadAction.
 * unit.test.ts) cannot catch: a "column reference document_id is
 * ambiguous" error only occurs inside Postgres's own name resolution when
 * the real finalize_document_upload function is actually invoked. A mocked
 * `supabase.rpc()` never sends anything to a real Postgres parser, so it
 * happily "succeeds" against a function whose PL/pgSQL body is broken. See
 * supabase/migrations/20260811100022_fix_finalize_document_upload_rpc.sql
 * for the fix this test guards.
 *
 * Every successful call permanently writes to documents /
 * document_extractions in the linked gansevoort-ops-dev database -- both
 * are append-only even for service_role (forbid_update_delete /
 * document_extractions_guard_transitions triggers), so there is no cleanup
 * path. Same deliberate, documented tradeoff as tests/withdrawal.rpc.test.ts.
 * A fresh randomUUID() documentId is used per test (except the dedicated
 * replay/conflict tests, which deliberately reuse one) so ordinary test
 * runs never collide with each other or with a prior run.
 */

let fx: RpcTestFixtures;

function baseInput(documentId: string): FinalizeDocumentUploadRpcInput {
  return {
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
  };
}

async function countAttempts(documentId: string): Promise<number> {
  const { count, error } = await fx.supabase
    .from("document_extractions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId);
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("finalize_document_upload RPC", () => {
  it("creates documents + attempt #1 on a fresh call, with no ambiguous-column error (regression for the RETURNS TABLE(document_id,...) vs document_extractions.document_id collision)", async () => {
    const documentId = randomUUID();
    const input = baseInput(documentId);

    const result = await finalizeDocumentUploadRpc(fx.supabase, input);

    expect(result).toEqual({ documentId, attemptId: expect.any(String), replayed: false });

    const { data: documentRow, error: documentError } = await fx.supabase
      .from("documents")
      .select("organization_id, storage_path, file_sha256, byte_size, content_type")
      .eq("id", documentId)
      .single();
    expect(documentError).toBeNull();
    expect(documentRow).toMatchObject({
      organization_id: fx.organizationId,
      storage_path: input.storagePath,
      file_sha256: input.fileSha256,
      byte_size: input.byteSize,
      content_type: input.contentType,
    });

    const { data: attemptRow, error: attemptError } = await fx.supabase
      .from("document_extractions")
      .select("attempt_number, status, provider, model")
      .eq("id", result.attemptId)
      .single();
    expect(attemptError).toBeNull();
    expect(attemptRow).toMatchObject({ attempt_number: 1, status: "PENDING", provider: "gemini", model: "gemini-3.6-flash" });

    expect(await countAttempts(documentId)).toBe(1);
  });

  it("idempotent replay: a second identical call returns replayed:true with the same attemptId, and creates no duplicate rows", async () => {
    const documentId = randomUUID();
    const input = baseInput(documentId);

    const first = await finalizeDocumentUploadRpc(fx.supabase, input);
    expect(first.replayed).toBe(false);

    const second = await finalizeDocumentUploadRpc(fx.supabase, input);
    expect(second.replayed).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(second.attemptId).toBe(first.attemptId);

    expect(await countAttempts(documentId)).toBe(1);
  });

  it("heals a missing attempt 1 when replayed against an existing document that has zero attempts", async () => {
    const documentId = randomUUID();
    const input = baseInput(documentId);

    // Insert the documents row directly, bypassing the RPC, to simulate the
    // "attempt insert failed on the very first finalize" scenario the heal
    // path exists for.
    const { error: insertError } = await fx.supabase.from("documents").insert({
      id: documentId,
      organization_id: input.organizationId,
      uploaded_by_app_user_id: input.uploadedByAppUserId,
      storage_path: input.storagePath,
      original_filename: input.originalFilename,
      content_type: input.contentType,
      byte_size: input.byteSize,
      file_sha256: input.fileSha256,
    });
    expect(insertError).toBeNull();
    expect(await countAttempts(documentId)).toBe(0);

    const result = await finalizeDocumentUploadRpc(fx.supabase, input);
    expect(result.replayed).toBe(true);
    expect(result.documentId).toBe(documentId);
    expect(result.attemptId).toBeTruthy();
    expect(await countAttempts(documentId)).toBe(1);
  });

  it("rejects a replay with mismatched immutable identity (different file_sha256) as a GA001 conflict, without creating a new document/attempt or touching the original row", async () => {
    const documentId = randomUUID();
    const input = baseInput(documentId);
    const original = await finalizeDocumentUploadRpc(fx.supabase, input);

    const conflicting = { ...input, fileSha256: randomBytes(32).toString("hex") };
    await expect(finalizeDocumentUploadRpc(fx.supabase, conflicting)).rejects.toBeInstanceOf(DocumentIdentityConflictError);

    const { data: documentRow } = await fx.supabase.from("documents").select("file_sha256").eq("id", documentId).single();
    expect(documentRow!.file_sha256).toBe(input.fileSha256); // untouched by the rejected conflicting call

    expect(await countAttempts(documentId)).toBe(1); // still just the original attempt

    const { data: attemptRow } = await fx.supabase.from("document_extractions").select("id").eq("document_id", documentId).single();
    expect(attemptRow!.id).toBe(original.attemptId);
  });

  it("two genuinely concurrent calls for the same new documentId both resolve to the identical result, with exactly one document and one attempt row", async () => {
    const documentId = randomUUID();
    const input = baseInput(documentId);

    const [a, b] = await Promise.all([finalizeDocumentUploadRpc(fx.supabase, input), finalizeDocumentUploadRpc(fx.supabase, input)]);

    expect(a.documentId).toBe(b.documentId);
    expect(a.attemptId).toBe(b.attemptId);
    // Exactly one of the two calls did the actual insert; the other hit
    // unique_violation and fell through to the compare-and-heal path.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    expect(await countAttempts(documentId)).toBe(1);
  });
});
