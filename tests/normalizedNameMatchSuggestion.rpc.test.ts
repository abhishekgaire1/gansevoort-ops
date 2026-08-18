import { beforeAll, describe, expect, it } from "vitest";
import { classifyPurchaseDocumentLines } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { setupRpcTestFixtures, createTestVendor, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Adversarial-review priority 8 (20260811100058). Tier 3 of
 * resolveDeterministicClassification (NORMALIZED_NAME_MATCH) is an exact,
 * case-insensitive item-name match with NO vendor scoping at all -- two
 * different vendors invoicing a generically-named line could previously
 * silently auto-CONFIRM to the same (possibly wrong) Item Master row with
 * zero human review. This now requires the same explicit manager
 * confirmation as any AI-suggested candidate. Tiers 1/2 (a manager's own
 * prior, vendor-scoped confirmation) are unchanged and re-verified here
 * too, so this migration didn't accidentally weaken them.
 */

let fx: RpcTestFixtures;
let spendCategoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

describe("NORMALIZED_NAME_MATCH becomes a manager-confirmable suggestion, never an auto-confirm", () => {
  it("two different vendors invoicing the same generic item name -- the second vendor's line is PENDING_REVIEW, never silently CONFIRMED", async () => {
    const uniqueBase = crypto.randomUUID().slice(0, 8);
    const itemName = `TEST Generic Chicken Breast ${uniqueBase}`;

    // Vendor A's line establishes the CONFIRMED item.
    const { purchaseDocumentId: pdA } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `NNM-A-${uniqueBase}`, description: itemName }],
    });
    const [lineA] = await getLineKeys(fx.supabase, pdA);
    const approved = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId: pdA,
      lineKey: lineA,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: itemName,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false, // deliberately NOT remembered for vendor A -- isolates tier 3 from tiers 1/2
    });

    // A genuinely different vendor (own org, own vendor row) invoices a
    // line with the exact same name, different casing/whitespace.
    const vendorB = await createTestVendor(fx.supabase, fx.organizationId, { namePrefix: "TEST NNM Vendor B", runId: uniqueBase });
    const { purchaseDocumentId: pdB } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: vendorB,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `NNM-B-${uniqueBase}`, description: `  ${itemName.toLowerCase()}  ` }],
    });
    const [lineB] = await getLineKeys(fx.supabase, pdB);

    await classifyPurchaseDocumentLines(pdB, fx.organizationId);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, resolution_source, inventory_item_id, ai_suggested_inventory_item_id")
      .eq("purchase_document_id", pdB)
      .eq("line_key", lineB)
      .single();

    expect(classification!.status).toBe("PENDING_REVIEW"); // never auto-CONFIRMED
    expect(classification!.resolution_source).toBe("NORMALIZED_NAME_MATCH");
    expect(classification!.inventory_item_id).toBeNull(); // not authoritative yet
    expect(classification!.ai_suggested_inventory_item_id).toBe(approved.inventoryItemId);

    // The manager can still confirm it explicitly, exactly like an
    // AI-suggested candidate.
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: pdB,
      lineKey: lineB,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: approved.inventoryItemId,
      rememberVendorMapping: false,
    });
    const { data: afterConfirm } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, inventory_item_id")
      .eq("purchase_document_id", pdB)
      .eq("line_key", lineB)
      .single();
    expect(afterConfirm!.status).toBe("CONFIRMED");
    expect(afterConfirm!.inventory_item_id).toBe(approved.inventoryItemId);
  });

  it("tiers 1/2 (a manager's own prior, vendor-scoped confirmation) remain deterministic-CONFIRMED, unchanged by this migration", async () => {
    const uniqueBase = crypto.randomUUID().slice(0, 8);
    const sku = `NNM-REMEMBERED-${uniqueBase}`;

    const { purchaseDocumentId: pd1 } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: sku, description: `TEST Remembered Mapping Item ${uniqueBase}` }],
    });
    const [line1] = await getLineKeys(fx.supabase, pd1);
    const approved = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId: pd1,
      lineKey: line1,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Remembered Mapping Item ${uniqueBase}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: true, // this vendor+SKU pairing is now remembered
    });

    // A NEW document, SAME vendor, SAME SKU -- tier 1 (VENDOR_SKU_MAPPING)
    // should resolve it deterministically, no manager review required.
    const { purchaseDocumentId: pd2 } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: sku, description: `TEST Remembered Mapping Item ${uniqueBase}` }],
    });
    const [line2] = await getLineKeys(fx.supabase, pd2);

    await classifyPurchaseDocumentLines(pd2, fx.organizationId);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, resolution_source, inventory_item_id")
      .eq("purchase_document_id", pd2)
      .eq("line_key", line2)
      .single();
    expect(classification!.status).toBe("CONFIRMED");
    expect(classification!.resolution_source).toBe("VENDOR_SKU_MAPPING");
    expect(classification!.inventory_item_id).toBe(approved.inventoryItemId);
  });
});
