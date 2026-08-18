import { beforeAll, describe, expect, it } from "vitest";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Adversarial-review priority 7 (20260811100061). A double-click or
 * network retry must not create two indistinguishable "effective"
 * DELIVERY receipts for the same document -- but legitimate additional
 * deliveries (a genuinely new logical submission) must remain fully
 * possible. Proves the idempotency key -- never "same document + same
 * lines," which would break real split/additional deliveries -- makes a
 * retry a true no-op replay, including under genuine concurrent races
 * (Promise.all, mirroring classificationRunClaim.rpc.test.ts's own
 * concurrency-proof shape).
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

async function draftPurchaseDocument(): Promise<string> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
  });
  return purchaseDocumentId;
}

describe("record_receipt idempotency", () => {
  it("a retry with the SAME idempotency key returns the SAME receipt -- no duplicate row, the retry's own line payload is never inserted", async () => {
    const purchaseDocumentId = await draftPurchaseDocument();
    const key = crypto.randomUUID();

    const first = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      notes: "first attempt",
      lines: [],
      idempotencyKey: key,
    });

    // A retry -- different notes, as a real double-click/retry with
    // slightly re-serialized state might produce -- must still collapse
    // into the SAME receipt, not create a second one.
    const retry = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      notes: "retry attempt -- should never be persisted",
      lines: [],
      idempotencyKey: key,
    });

    expect(retry.receiptId).toBe(first.receiptId);

    const { data: receipts, count } = await fx.supabase
      .from("receipts")
      .select("id, notes", { count: "exact" })
      .eq("organization_id", fx.organizationId)
      .eq("idempotency_key", key);
    expect(count).toBe(1);
    expect(receipts![0].notes).toBe("first attempt"); // the retry's own payload was discarded
  });

  it("a DIFFERENT idempotency key creates a genuinely new, additional delivery -- same document, both receipts persist", async () => {
    const purchaseDocumentId = await draftPurchaseDocument();

    const first = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [],
      idempotencyKey: crypto.randomUUID(),
    });
    const second = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [],
      idempotencyKey: crypto.randomUUID(),
    });

    expect(second.receiptId).not.toBe(first.receiptId);
    const { count } = await fx.supabase.from("receipts").select("id", { count: "exact", head: true }).eq("purchase_document_id", purchaseDocumentId);
    expect(count).toBe(2);
  });

  it("two simultaneous callers racing with the SAME key resolve to exactly one created receipt, never two", async () => {
    const purchaseDocumentId = await draftPurchaseDocument();
    const key = crypto.randomUUID();

    const [a, b] = await Promise.all([
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "DELIVERY",
        purchaseDocumentId,
        lines: [],
        idempotencyKey: key,
      }),
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "DELIVERY",
        purchaseDocumentId,
        lines: [],
        idempotencyKey: key,
      }),
    ]);

    expect(a.receiptId).toBe(b.receiptId); // both callers converge on the same winner

    const { count } = await fx.supabase.from("receipts").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId).eq("idempotency_key", key);
    expect(count).toBe(1);
  });

  it("omitting the key entirely preserves today's behavior -- no idempotency checking, each call is its own receipt", async () => {
    const purchaseDocumentId = await draftPurchaseDocument();

    const first = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [],
    });
    const second = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [],
    });

    expect(second.receiptId).not.toBe(first.receiptId);
  });
});
