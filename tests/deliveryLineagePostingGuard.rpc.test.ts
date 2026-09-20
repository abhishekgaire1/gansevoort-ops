import { beforeAll, describe, expect, it } from "vitest";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { postPurchaseDocumentSoleApproverRpc } from "@/app/lib/purchaseDocuments/soleApproverPostingRpc";
import { DeliveryConflictError } from "@/app/lib/purchaseDocuments/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument, createSubmittedPostingDocument, getPostingStatus, getLocationBalance } from "./inventoryPostingTestHelpers";

async function grantSoleApprover(supabase: typeof fx.supabase, organizationId: string, appUserId: string): Promise<void> {
  const { data: role } = await supabase.from("roles").select("id").eq("name", "purchase_sole_approver").single();
  await supabase.from("user_roles").upsert({ app_user_id: appUserId, role_id: role!.id, organization_id: organizationId }, { onConflict: "app_user_id,role_id" });
}

/**
 * MANUAL / ON-DEMAND (shared DEV DB) -- the database-level GA080 delivery-lineage
 * guard (20260811100172). Proves NO posting path can bypass it: a direct RPC
 * call on an ambiguous document (the same physical delivery recorded twice, no
 * delivery_event_id, no price history) is rejected with GA080 and writes
 * nothing. A single-delivery document still posts normally.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

describe("GA080 delivery-lineage posting guard (database-enforced, direct-RPC-proof)", () => {
  it("a direct normal-posting RPC on ambiguous lineage (no price history) is rejected with GA080 and writes nothing", async () => {
    // Two independent DELIVERY receipts, no delivery_event_id -> ambiguous.
    const doc = await createVerifiedPostingDocument(
      fx.supabase,
      fx,
      locationId,
      [{ description: "Ambiguous Dup", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 30, receivedUnit: "PIECE" } }],
      { extraNullEventDeliveries: 1 },
    );

    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      }),
    ).rejects.toBeInstanceOf(DeliveryConflictError);

    // Zero writes: no posting header/lines, no movements, no balance, status not posted.
    const status = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.status).toBe("NOT_POSTED");
    expect(status.postedLineCount).toBe(0);
    const { count: headerCount } = await fx.supabase
      .from("purchase_document_inventory_postings")
      .select("id", { count: "exact", head: true })
      .eq("purchase_document_id", doc.purchaseDocumentId);
    expect(headerCount ?? 0).toBe(0);
    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBeNull();
  });

  it("a direct sole-approver posting RPC on ambiguous lineage is also rejected with GA080", async () => {
    // Sole-approver posts a DRAFT (verify+post in one call); build the ambiguous
    // draft and grant the actor the sole-approver permission.
    const draft = await createSubmittedPostingDocument(
      fx.supabase,
      fx,
      locationId,
      [{ description: "Ambiguous Dup SA", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 15, receivedUnit: "PIECE" } }],
      { extraNullEventDeliveries: 1, skipSubmit: true },
    );
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);
    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: draft.submittedVersion,
        reason: "SECOND_REVIEWER_UNAVAILABLE",
        notes: null,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeliveryConflictError);
    const { count } = await fx.supabase.from("purchase_document_inventory_postings").select("id", { count: "exact", head: true }).eq("purchase_document_id", draft.purchaseDocumentId);
    expect(count ?? 0).toBe(0);
  });

  it("a single-delivery document (unambiguous) still posts normally", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Clean Single", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 9, receivedUnit: "PIECE" } },
    ]);
    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.status).toBe("POSTED");
    expect(result.postedLineCount).toBe(1);
  });
});
