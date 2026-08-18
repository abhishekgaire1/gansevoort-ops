import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { computeReceivingPrefill } from "@/app/lib/receiving/computeReceivingPrefill";

export interface ReviewSummaryItemLine {
  lineKey: string;
  vendorSku: string | null;
  description: string | null;
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  status: "CONFIRMED" | "PENDING_REVIEW" | "STALE" | "UNCLASSIFIED";
  canonicalItemName: string | null;
  categoryName: string | null;
  spendCategoryPath: string | null;
  baseUnitCode: string | null;
  purchaseUnitCode: string | null;
  receivingBehavior: string | null;
}

export interface ReviewSummaryReceivingLine {
  lineKey: string;
  description: string | null;
  expectedQuantity: number | null;
  expectedUnit: string | null;
  receivedQuantity: number | null;
  receivedUnit: string | null;
  requiresVerifiedMeasurement: boolean;
  verifiedQuantity: number | null;
  verifiedUnit: string | null;
  /** Only populated when the received unit is a packaging/purchase unit
   * distinct from the item's base unit (e.g. "Received 2 CASE" also
   * showing "Inventory Quantity 48 PIECE") -- never shown when it would
   * just repeat the received quantity. */
  inventoryQuantity: number | null;
  locationName: string | null;
  conditionStatus: string | null;
}

export interface ReviewSummaryNonInventoryLine {
  lineKey: string;
  description: string | null;
  lineTotal: number | null;
  spendCategoryPath: string | null;
}

export interface ReviewSummaryException {
  lineKey: string;
  description: string | null;
  message: string;
}

export interface PurchaseDocumentReviewSummary {
  items: ReviewSummaryItemLine[];
  itemsConfirmedCount: number;
  itemsTotalCount: number;
  receiving: ReviewSummaryReceivingLine[];
  receivingCompleteCount: number;
  receivingTotalCount: number;
  nonInventory: ReviewSummaryNonInventoryLine[];
  exceptions: ReviewSummaryException[];
}

const CONDITION_LABEL: Record<string, string> = {
  RECEIVED_AS_INVOICED: "As invoiced",
  SHORT: "Short",
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong item",
  NOT_RECEIVED: "Not received",
  EXCESS: "Excess",
  OTHER: "Other",
};

/** Walks parent_id up to the root and joins names with " > " -- the same
 * flattened-path idea already used for the spend-category picker, just
 * for read-only display here. */
function buildSpendCategoryPathResolver(rows: { id: string; parent_id: string | null; name: string }[]): (id: string | null) => string | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string | null) => {
    if (id === null) return null;
    const parts: string[] = [];
    let current = byId.get(id);
    let guard = 0;
    while (current && guard < 20) {
      parts.unshift(current.name);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
      guard += 1;
    }
    return parts.length > 0 ? parts.join(" > ") : null;
  };
}

/**
 * Assembles everything Step 4 -- Review & Send needs for its read-only
 * summary, purely by aggregating data every earlier step already
 * produced (classifications, receiving config, receipt facts) -- no new
 * schema, no new authoritative facts, nothing here can disagree with the
 * completion gate itself (getPreparationStatus), which remains the only
 * thing that decides ready/not-ready.
 */
export async function getPurchaseDocumentReviewSummary(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<PurchaseDocumentReviewSummary> {
  const [{ data: lines }, { data: classifications }, receivingLines, { data: categories }, { data: spendCategories }] = await Promise.all([
    supabase
      .from("purchase_document_lines")
      .select("line_key, line_number, vendor_sku, description, line_total")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", organizationId)
      .order("line_number"),
    supabase
      .from("purchase_document_line_classifications")
      .select("line_key, status, disposition, inventory_item_id, spend_category_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", organizationId),
    getReceivingLines(supabase, purchaseDocumentId, organizationId),
    supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId),
    supabase.from("spend_categories").select("id, parent_id, name").eq("organization_id", organizationId),
  ]);

  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));
  const receivingByLineKey = new Map(receivingLines.map((l) => [l.lineKey, l]));
  const categoryNameById = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));
  const spendCategoryPath = buildSpendCategoryPathResolver((spendCategories ?? []) as { id: string; parent_id: string | null; name: string }[]);

  const itemIds = Array.from(
    new Set((classifications ?? []).map((c) => c.inventory_item_id as string | null).filter((id): id is string => Boolean(id)))
  );
  const { data: items } = itemIds.length > 0 ? await supabase.from("inventory_items").select("id, name, category_id").in("id", itemIds) : { data: [] };
  const itemById = new Map((items ?? []).map((i) => [i.id as string, i]));

  const { data: effectiveReceipts } = await supabase.rpc("effective_receipts_for_purchase_document", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  const effectiveReceiptIds = ((effectiveReceipts ?? []) as { id: string }[]).map((r) => r.id);
  const { data: receiptLines } =
    effectiveReceiptIds.length > 0
      ? await supabase
          .from("receipt_lines")
          .select("matched_line_key, actual_received_package_quantity, actual_received_package_unit, actual_verified_base_quantity, location_id, condition_status")
          .in("receipt_id", effectiveReceiptIds)
          // Ascending -- if more than one effective receipt ever touches
          // the same line (a legitimate split/additional delivery), the
          // LAST write into the map below is the most recent one, the
          // same explicit "most recent wins" rule already used for
          // invoice-unit confirmations (getReceivingLines.ts) -- never an
          // unspecified/arbitrary row order.
          .order("created_at", { ascending: true })
      : { data: [] };
  const receiptLineByMatchedKey = new Map((receiptLines ?? []).filter((r) => r.matched_line_key).map((r) => [r.matched_line_key as string, r]));

  const locationIds = Array.from(new Set((receiptLines ?? []).map((r) => r.location_id as string | null).filter((id): id is string => Boolean(id))));
  const { data: locations } = locationIds.length > 0 ? await supabase.from("locations").select("id, name").in("id", locationIds) : { data: [] };
  const locationNameById = new Map((locations ?? []).map((l) => [l.id as string, l.name as string]));

  const items_: ReviewSummaryItemLine[] = [];
  const receiving: ReviewSummaryReceivingLine[] = [];
  const nonInventory: ReviewSummaryNonInventoryLine[] = [];
  const exceptions: ReviewSummaryException[] = [];

  for (const line of lines ?? []) {
    const lineKey = line.line_key as string;
    const classification = classificationByLineKey.get(lineKey);
    const item = classification?.inventory_item_id ? itemById.get(classification.inventory_item_id as string) : undefined;
    const receivingInfo = receivingByLineKey.get(lineKey);

    const status: ReviewSummaryItemLine["status"] = !classification
      ? "UNCLASSIFIED"
      : (classification.status as "CONFIRMED" | "PENDING_REVIEW" | "STALE");
    const disposition: ReviewSummaryItemLine["disposition"] = (classification?.disposition as ReviewSummaryItemLine["disposition"] | undefined) ?? "UNRESOLVED";

    items_.push({
      lineKey,
      vendorSku: line.vendor_sku as string | null,
      description: line.description as string | null,
      disposition,
      status,
      canonicalItemName: (item?.name as string | undefined) ?? null,
      categoryName: item?.category_id ? (categoryNameById.get(item.category_id as string) ?? null) : null,
      spendCategoryPath: spendCategoryPath((classification?.spend_category_id as string | null) ?? null),
      baseUnitCode: receivingInfo?.baseUnitCode ?? null,
      purchaseUnitCode: receivingInfo?.purchaseUnitCode ?? null,
      receivingBehavior: receivingInfo?.receivingBehavior ?? null,
    });

    if (status !== "CONFIRMED") continue;

    if (disposition === "NON_INVENTORY") {
      nonInventory.push({
        lineKey,
        description: line.description as string | null,
        lineTotal: line.line_total as number | null,
        spendCategoryPath: spendCategoryPath((classification?.spend_category_id as string | null) ?? null),
      });
      continue;
    }

    if (disposition !== "INVENTORY" || !receivingInfo) continue;

    const receiptLine = receiptLineByMatchedKey.get(lineKey);
    const prefill = computeReceivingPrefill(receivingInfo);
    const expectedUnit = prefill.receivedUnit || receivingInfo.invoicePackageUnit;
    const receivedQuantity = (receiptLine?.actual_received_package_quantity as number | null) ?? null;
    const receivedUnit = (receiptLine?.actual_received_package_unit as string | null) ?? null;
    const conditionStatus = (receiptLine?.condition_status as string | null) ?? null;

    const isPackagingUnit =
      receivingInfo.receivingBehavior === "FIXED_CONVERSION" &&
      receivedUnit !== null &&
      receivingInfo.baseUnitCode !== null &&
      receivedUnit.trim().toLowerCase() !== receivingInfo.baseUnitCode.trim().toLowerCase() &&
      receivingInfo.fixedConversionFactor !== null;

    receiving.push({
      lineKey,
      description: line.description as string | null,
      expectedQuantity: receivingInfo.invoicePackageQuantity,
      expectedUnit,
      receivedQuantity,
      receivedUnit,
      requiresVerifiedMeasurement: receivingInfo.requiresVerifiedMeasurement,
      verifiedQuantity: (receiptLine?.actual_verified_base_quantity as number | null) ?? null,
      verifiedUnit: receivingInfo.baseUnitCode,
      inventoryQuantity: isPackagingUnit ? (receivedQuantity as number) * (receivingInfo.fixedConversionFactor as number) : null,
      locationName: receiptLine?.location_id ? (locationNameById.get(receiptLine.location_id as string) ?? null) : null,
      conditionStatus,
    });

    if (conditionStatus && conditionStatus !== "RECEIVED_AS_INVOICED") {
      exceptions.push({
        lineKey,
        description: line.description as string | null,
        message: `${line.description ?? "Line"} — ${CONDITION_LABEL[conditionStatus] ?? conditionStatus}`,
      });
    }
    if (receivedQuantity !== null && receivingInfo.invoicePackageQuantity !== null && receivedQuantity !== receivingInfo.invoicePackageQuantity) {
      exceptions.push({
        lineKey,
        description: line.description as string | null,
        message: `${line.description ?? "Line"} — received ${receivedQuantity}${receivedUnit ? ` ${receivedUnit}` : ""}, invoice expected ${receivingInfo.invoicePackageQuantity}${expectedUnit ? ` ${expectedUnit}` : ""}`,
      });
    }
  }

  const itemsConfirmedCount = items_.filter((i) => i.status === "CONFIRMED").length;
  const receivingCompleteCount = receiving.filter(
    (r) => r.receivedQuantity !== null && r.locationName !== null && (!r.requiresVerifiedMeasurement || r.verifiedQuantity !== null)
  ).length;

  return {
    items: items_,
    itemsConfirmedCount,
    itemsTotalCount: items_.length,
    receiving,
    receivingCompleteCount,
    receivingTotalCount: receiving.length,
    nonInventory,
    exceptions,
  };
}
