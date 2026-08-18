import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the full AI-prefill data flow end to end against real Postgres:
 * record_ai_item_proposal resolves category/spend-category/base-unit onto
 * the pending item directly BY ID (not just base unit -- category and spend
 * category too, which is exactly what ItemMappingPanel/ReviewQueueManager
 * read via aiNewItemProposal to pre-fill the New Item Review form's fields).
 * IDs, not free-text names, are the authoritative resolution mechanism as of
 * 20260811100049 -- see app/lib/ai/tasks/itemClassification/instructions.ts
 * for why: asking Gemini to invent a category NAME and matching it later
 * against canonical names is exactly the brittleness that left a real
 * Gansevoort DEV invoice line (a cheese wheel) with a null category, because
 * the model said "Dairy" against a canonical "Dairy & Eggs". The model is
 * now given the org's own candidate ids directly and must select from them.
 * Also proves the edge case this uncovered: when a proposed category id does
 * not belong to this organization (e.g. hallucinated, or from another org),
 * category_id/spend_category_id stay null and the database's own
 * inventory_items_category_required_check rejects a CONFIRMED approval
 * outright -- which is exactly why the New Item Review form's VERIFY ITEM
 * button stays disabled until the manager picks a category/base unit
 * themselves in that case, rather than allowing a click that could only
 * ever fail.
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("AI item proposal prefill", () => {
  it("resolves category, spend category, and base unit by id, and one-click APPROVE succeeds with zero manual selection", async () => {
    const { data: existingCat } = await fx.supabase
      .from("inventory_categories")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .ilike("name", "TEST RPC Fixture Category")
      .maybeSingle();
    const categoryId = existingCat!.id as string;

    let spendCategoryId: string;
    const { data: existingSpend } = await fx.supabase.from("spend_categories").select("id").eq("organization_id", fx.organizationId).limit(1).maybeSingle();
    if (existingSpend) {
      spendCategoryId = existingSpend.id as string;
    } else {
      const { data: created } = await fx.supabase
        .from("spend_categories")
        .insert({ organization_id: fx.organizationId, name: "TEST Prefill Spend Root" })
        .select("id")
        .single();
      spendCategoryId = created!.id as string;
    }

    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "PREFILL-1", description: "Prefill Test Radish", packageUnit: "BOX", measuredUnit: "LB" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const proposal = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: `Prefill Test Radish ${purchaseDocumentId.slice(0, 8)}`,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: categoryId,
      proposedSpendCategoryId: spendCategoryId,
      proposedBaseUnitCode: "LB",
      aiConfidence: 0.9,
      proposedVendorPurchaseUnitCode: "BOX",
      proposedReceivingBehavior: "MEASURE_EACH_DELIVERY",
      proposedFixedConversionFactor: null,
    });

    const { data: pendingItem } = await fx.supabase
      .from("inventory_items")
      .select("id, name, disposition, category_id, spend_category_id, base_unit_id, units(code)")
      .eq("id", proposal.inventoryItemId)
      .single();
    const baseUnit = Array.isArray(pendingItem!.units) ? pendingItem!.units[0] : pendingItem!.units;

    expect(pendingItem!.disposition).toBe("INVENTORY");
    expect(pendingItem!.category_id).not.toBeNull();
    expect(pendingItem!.spend_category_id).not.toBeNull();
    expect(baseUnit?.code).toBe("LB");

    const approved = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: pendingItem!.name as string,
      disposition: "INVENTORY",
      categoryId: pendingItem!.category_id as string,
      spendCategoryId: pendingItem!.spend_category_id as string,
      baseUnitCode: baseUnit!.code as string,
      pendingItemId: proposal.inventoryItemId,
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      rememberVendorMapping: false,
    });
    expect(approved.inventoryItemId).toBe(proposal.inventoryItemId);
  });

  it("leaves category/spend-category null when the proposed id does not belong to this organization, and a one-click CONFIRMED approve with null category is rejected", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "PREFILL-2", description: "No Match Item", packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    // A genuinely random uuid, deliberately not the id of anything in this
    // (or any) organization -- proves the RPC's own org-ownership check is
    // real defense in depth, not merely trusting whatever id it's handed
    // (the application layer should already have refused to send an id like
    // this, since validate.ts only lets through ids literally present in
    // the candidate list the model was given).
    const proposal = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: `No Match Item ${purchaseDocumentId.slice(0, 8)}`,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: randomUUID(),
      proposedSpendCategoryId: randomUUID(),
      proposedBaseUnitCode: "PIECE",
      aiConfidence: 0.5,
    });

    const { data: pendingItem } = await fx.supabase
      .from("inventory_items")
      .select("category_id, spend_category_id, base_unit_id")
      .eq("id", proposal.inventoryItemId)
      .single();
    expect(pendingItem!.category_id).toBeNull();
    expect(pendingItem!.spend_category_id).toBeNull();
    expect(pendingItem!.base_unit_id).not.toBeNull(); // a real code ("PIECE") still resolves independently of category

    // This is exactly why the New Item Review form's VERIFY ITEM button is
    // disabled whenever categoryId is still empty for an INVENTORY item --
    // confirming one with no category is rejected at the database level,
    // not silently allowed through.
    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: `No Match Item ${purchaseDocumentId.slice(0, 8)}`,
        disposition: "INVENTORY",
        categoryId: null,
        spendCategoryId: null,
        baseUnitCode: "PIECE",
        pendingItemId: proposal.inventoryItemId,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow();
  });

  it("rejects a new-item approval with no spend category, server-side, regardless of client validation (20260811100051)", async () => {
    const { data: existingCat } = await fx.supabase
      .from("inventory_categories")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .ilike("name", "TEST RPC Fixture Category")
      .maybeSingle();
    const categoryId = existingCat!.id as string;

    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "PREFILL-3", description: "No Spend Category Item", packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: `No Spend Category Item ${purchaseDocumentId.slice(0, 8)}`,
        disposition: "INVENTORY",
        categoryId,
        spendCategoryId: null,
        baseUnitCode: "PIECE",
        pendingItemId: null,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow();
  });

  it("safely refreshes an unconfirmed AI proposal by reusing the SAME pending item row, never creating a duplicate (20260811100050)", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "PREFILL-4", description: "Heavy Cream Refresh Test", packageUnit: null, measuredUnit: null }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const itemName = `Heavy Cream Refresh Test ${purchaseDocumentId.slice(0, 8)}`;

    const { data: existingCat } = await fx.supabase
      .from("inventory_categories")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .ilike("name", "TEST RPC Fixture Category")
      .maybeSingle();
    const categoryId = existingCat!.id as string;

    // First run: old-classifier-shaped result, category unresolved.
    const first = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: itemName,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: null,
      proposedSpendCategoryId: null,
      proposedBaseUnitCode: null,
      aiConfidence: 0.9,
    });

    // Second run (the "Run Item Matching" refresh): new-classifier-shaped
    // result, category now resolved.
    const second = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: itemName,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: categoryId,
      proposedSpendCategoryId: null,
      proposedBaseUnitCode: "LB",
      aiConfidence: 0.92,
    });

    expect(second.inventoryItemId).toBe(first.inventoryItemId);

    const { data: items } = await fx.supabase.from("inventory_items").select("id, category_id").eq("organization_id", fx.organizationId).eq("name", itemName);
    expect(items).toHaveLength(1);
    expect(items![0].category_id).toBe(categoryId);
  });

  it("preserves a line whose classification is already CONFIRMED as a no-op, even via the refresh path -- adversarial-review priority 2 changed this from a raised error to a silent no-op, so a race against a manager's own confirmation never aborts the rest of a batch (see 20260811100057)", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "PREFILL-5", description: "Already Confirmed Item", packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const { data: existingCat } = await fx.supabase
      .from("inventory_categories")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .ilike("name", "TEST RPC Fixture Category")
      .maybeSingle();
    const categoryId = existingCat!.id as string;

    const { data: existingSpend } = await fx.supabase.from("spend_categories").select("id").eq("organization_id", fx.organizationId).limit(1).maybeSingle();
    const spendCategoryId = existingSpend!.id as string;

    const confirmed = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Already Confirmed Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      pendingItemId: null,
      rememberVendorMapping: false,
    });

    const rejectedName = `TEST Should never be created -- line is already CONFIRMED ${crypto.randomUUID().slice(0, 8)}`;
    const proposalResult = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: rejectedName,
      proposedDisposition: "INVENTORY",
      proposedCategoryId: categoryId,
      proposedSpendCategoryId: spendCategoryId,
      proposedBaseUnitCode: "PIECE",
      aiConfidence: 0.9,
    });
    // No-op: returns the EXISTING confirmed item, never a fresh proposal.
    expect(proposalResult.inventoryItemId).toBe(confirmed.inventoryItemId);

    const { data: items } = await fx.supabase.from("inventory_items").select("id").eq("organization_id", fx.organizationId).eq("name", rejectedName);
    expect(items).toHaveLength(0);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, inventory_item_id, resolved_by_app_user_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(classification!.status).toBe("CONFIRMED");
    expect(classification!.inventory_item_id).toBe(confirmed.inventoryItemId);
    expect(classification!.resolved_by_app_user_id).toBe(fx.changeableEmployeeAppUserId); // attribution untouched
  });
});
