import { beforeAll, describe, expect, it } from "vitest";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves getReceivingLines (the ReceivingPanel's read model) correctly
 * derives requiresVerifiedMeasurement from each item's OWN confirmed
 * inventory_item_units configuration against real Postgres -- the exact
 * signal the UI uses to require (and never auto-fill) a Verified Weight
 * field.
 */

let fx: RpcTestFixtures;
let categoryId: string;
let spendCategoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

describe("getReceivingLines", () => {
  it("flags a MEASURE_EACH_DELIVERY item as requiring verified measurement, with correct base/purchase units", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "KOR-RADISH-2", description: "Korean Radish", packageUnit: "BOX", measuredUnit: "LB" }],
    });
    const { data: line } = await fx.supabase.from("purchase_document_lines").select("line_key").eq("purchase_document_id", purchaseDocumentId).single();

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: line!.line_key as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Korean Radish ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      rememberVendorMapping: false,
    });

    const receivingLines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(receivingLines).toHaveLength(1);
    expect(receivingLines[0]).toMatchObject({
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      requiresVerifiedMeasurement: true,
      fixedConversionFactor: null,
    });
  });

  it("does not require verified measurement for a SAME_UNIT item", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SAME-UNIT-2", description: "Same Unit Item", packageUnit: "LB", measuredUnit: "LB" }],
    });
    const { data: line } = await fx.supabase.from("purchase_document_lines").select("line_key").eq("purchase_document_id", purchaseDocumentId).single();

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey: line!.line_key as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Same Unit Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      rememberVendorMapping: false,
    });

    const receivingLines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(receivingLines[0]).toMatchObject({ receivingBehavior: "SAME_UNIT", requiresVerifiedMeasurement: false });
  });

  it("gives an unclassified line no receiving-behavior fields", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "UNCLASSIFIED-1", description: "Never Classified" }],
    });

    const receivingLines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(receivingLines[0]).toMatchObject({ disposition: "UNRESOLVED", requiresVerifiedMeasurement: false, receivingBehavior: null });
  });
});
