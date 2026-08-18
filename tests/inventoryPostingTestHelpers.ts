import type { SupabaseClient } from "@supabase/supabase-js";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import type { RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";

/**
 * Shared 2A.4 posting-test helper: builds a REAL VERIFIED purchase
 * document whose inventory lines have the exact receiving configuration a
 * test needs (SAME_UNIT / FIXED_CONVERSION / MEASURE_EACH_DELIVERY /
 * NON_INVENTORY), fully received/located/delivery-verified, submitted by
 * the changeable-employee manager and final-verified by the locked-
 * employee manager -- so each posting test exercises posting itself, not
 * an unrelated completion-gate failure.
 */

export interface PostingTestLineSpec {
  description: string;
  /** null = NON_INVENTORY line (never posts). */
  receiving:
    | null
    | {
        behavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY";
        baseUnitCode: string;
        /** Required for FIXED_CONVERSION / MEASURE_EACH_DELIVERY. */
        purchaseUnitCode?: string;
        fixedConversionFactor?: number;
        receivedQuantity: number;
        receivedUnit: string;
        verifiedBaseQuantity?: number | null;
        /** Defaults to the fixture org's primary location. */
        locationId?: string;
      };
}

export interface VerifiedPostingDocument {
  purchaseDocumentId: string;
  documentId: string;
  lineKeys: string[];
  /** Confirmed inventory_item ids, in line order (null for NON_INVENTORY). */
  itemIds: (string | null)[];
  verifiedVersion: number;
}

export interface SubmittedPostingDocument {
  purchaseDocumentId: string;
  documentId: string;
  lineKeys: string[];
  /** Confirmed inventory_item ids, in line order (null for NON_INVENTORY). */
  itemIds: (string | null)[];
  submittedVersion: number;
}

/** Same document as createVerifiedPostingDocument, stopped at
 * READY_FOR_VERIFICATION -- the starting state for Manager 2
 * reviewer-correction tests (20260811100070). */
export async function createSubmittedPostingDocument(
  supabase: SupabaseClient,
  fx: RpcTestFixtures,
  primaryLocationId: string,
  specs: PostingTestLineSpec[]
): Promise<SubmittedPostingDocument> {
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(supabase, fx.organizationId);
  const { data: categoryRow } = await supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const categoryId = categoryRow!.category_id as string;
  const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(supabase, fx.organizationId, "TEST Delivery Verifier");

  const runTag = crypto.randomUUID().slice(0, 8);
  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: specs.map((spec, index) => ({
      vendorSku: `POST-${runTag}-${index}`,
      description: spec.description,
      packageUnit: spec.receiving?.receivedUnit ?? null,
      packageQuantity: spec.receiving?.receivedQuantity ?? 1,
    })),
  });
  const lineKeys = await getLineKeys(supabase, purchaseDocumentId);

  const itemIds: (string | null)[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (spec.receiving === null) {
      await approveLineClassificationNewItemRpc(supabase, {
        purchaseDocumentId,
        lineKey: lineKeys[index],
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: `TEST Post NonInv ${spec.description} ${runTag}`,
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      });
      itemIds.push(null);
      continue;
    }

    const result = await approveLineClassificationNewItemRpc(supabase, {
      purchaseDocumentId,
      lineKey: lineKeys[index],
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Post ${spec.description} ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: spec.receiving.baseUnitCode,
      purchaseUnitCode: spec.receiving.behavior === "SAME_UNIT" ? null : spec.receiving.purchaseUnitCode,
      receivingBehavior: spec.receiving.behavior === "SAME_UNIT" ? null : spec.receiving.behavior,
      fixedConversionFactor: spec.receiving.behavior === "FIXED_CONVERSION" ? spec.receiving.fixedConversionFactor : null,
      rememberVendorMapping: false,
    });
    itemIds.push(result.inventoryItemId);
  }

  await recordReceiptRpc(supabase, {
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    receiptKind: "DELIVERY",
    purchaseDocumentId,
    lines: specs
      .map((spec, index) =>
        spec.receiving === null
          ? null
          : {
              lineNumberSnapshot: index + 1,
              matchedLineKey: lineKeys[index],
              vendorSkuSnapshot: `POST-${runTag}-${index}`,
              descriptionSnapshot: spec.description,
              invoicePackageQuantity: spec.receiving.receivedQuantity,
              invoicePackageUnit: spec.receiving.receivedUnit,
              invoiceMeasuredQuantity: null,
              invoiceMeasuredUnit: null,
              actualReceivedPackageQuantity: spec.receiving.receivedQuantity,
              actualReceivedPackageUnit: spec.receiving.receivedUnit,
              actualVerifiedBaseQuantity: spec.receiving.verifiedBaseQuantity ?? null,
              actualVerifiedBaseUnitId: null,
              locationId: spec.receiving.locationId ?? primaryLocationId,
            }
      )
      .filter((line): line is NonNullable<typeof line> => line !== null),
  });

  await correctDocumentDeliveryVerifierRpc(supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    newEmployeeId: deliveryVerifierEmployeeId,
  });

  const submitted = await submitPurchaseDocumentForVerificationRpc(supabase, {
    purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    expectedVersion: 1,
  });

  return { purchaseDocumentId, documentId, lineKeys, itemIds, submittedVersion: submitted.version };
}

export async function createVerifiedPostingDocument(
  supabase: SupabaseClient,
  fx: RpcTestFixtures,
  primaryLocationId: string,
  specs: PostingTestLineSpec[]
): Promise<VerifiedPostingDocument> {
  const submitted = await createSubmittedPostingDocument(supabase, fx, primaryLocationId, specs);
  await verifyPurchaseDocumentRpc(supabase, {
    purchaseDocumentId: submitted.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.lockedEmployeeAppUserId,
    expectedVersion: submitted.submittedVersion,
  });

  return {
    purchaseDocumentId: submitted.purchaseDocumentId,
    documentId: submitted.documentId,
    lineKeys: submitted.lineKeys,
    itemIds: submitted.itemIds,
    verifiedVersion: submitted.submittedVersion + 1,
  };
}

export async function getPostingStatus(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<{ status: string; requiredLineCount: number; postedLineCount: number }> {
  const { data, error } = await supabase.rpc("purchase_document_inventory_posting_status", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { out_status: string; out_required_line_count: number; out_posted_line_count: number };
  return { status: row.out_status, requiredLineCount: row.out_required_line_count, postedLineCount: row.out_posted_line_count };
}

export async function getLocationBalance(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string
): Promise<number | null> {
  const { data, error } = await supabase.rpc("inventory_location_balances", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as { out_inventory_item_id: string; out_location_id: string; out_balance: number }[]).find(
    (r) => r.out_inventory_item_id === inventoryItemId && r.out_location_id === locationId
  );
  return row ? Number(row.out_balance) : null;
}

export async function getCurrentReference(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string
): Promise<{ fullQuantity: number; source: string } | null> {
  const { data } = await supabase
    .from("inventory_stock_references")
    .select("full_quantity, source, created_at, id")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", inventoryItemId)
    .eq("location_id", locationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { fullQuantity: Number(data.full_quantity), source: data.source as string } : null;
}
