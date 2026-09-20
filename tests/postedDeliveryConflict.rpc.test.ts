import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { getPostedDeliveryConflict } from "@/app/lib/inventory/deliveryConflictCorrection";

/**
 * §4 posted-delivery-conflict read model (MANUAL / ON-DEMAND, real Postgres).
 *
 * The database GA080 guard (20260811100172) now blocks posting an ambiguous
 * document, so no NEW document can reach the posted-and-ambiguous state; it only
 * exists for documents posted before the guard existed. This proves the handoff
 * read model does NOT fire a false positive on a clean, single-delivery posted
 * document, and returns no correction when nothing is duplicated. The positive
 * (excess-removal) path delegates entirely to the already-tested, audited,
 * idempotent, negative-blocking record_inventory_correction primitive
 * (20260811100141), invoked with a server-recalculated DELTA.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = loc!.id as string;
});

describe("getPostedDeliveryConflict", () => {
  it("returns no conflict for a clean single-delivery posted document (no false positive)", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Clean Posted", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 12, receivedUnit: "PIECE" } },
    ]);
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");

    const conflict = await getPostedDeliveryConflict(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(conflict.isPostedConflict).toBe(false);
    expect(conflict.items).toHaveLength(0);
  });

  it("returns no conflict for an unposted document (nothing has moved yet)", async () => {
    const doc = await createVerifiedPostingDocument(
      fx.supabase,
      fx,
      locationId,
      [{ description: "Ambiguous Unposted", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 8, receivedUnit: "PIECE" } }],
      { extraNullEventDeliveries: 1 },
    );
    // Ambiguous but never posted -> the handoff must not offer to correct anything.
    const conflict = await getPostedDeliveryConflict(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(conflict.isPostedConflict).toBe(false);
    expect(conflict.postingIds).toHaveLength(0);
  });
});
