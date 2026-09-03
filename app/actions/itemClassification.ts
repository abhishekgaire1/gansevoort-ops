"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { classifyPurchaseDocumentLines } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";
import { getClassificationRunStatus } from "@/app/lib/itemMaster/getClassificationRunStatus";
import { listUnresolvedClassifications, type UnresolvedClassificationRow } from "@/app/lib/itemMaster/listUnresolvedClassifications";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { bulkConfirmLineClassificationsRpc } from "@/app/lib/itemMaster/bulkConfirmLineClassificationsRpc";
import {
  LineNotFoundInCurrentRevisionError,
  ItemNotPendingReviewError,
  DuplicateItemNameError,
  LineAlreadyConfirmedAgainstDifferentItemError,
  InvalidUsageUnitConfigurationError,
  NonInventoryItemUsageUnitError,
} from "@/app/lib/itemMaster/errors";
import { NotPreparerError } from "@/app/lib/purchaseDocuments/errors";
import { resolveLineMismatchFields, resolveUnitCode } from "@/app/lib/purchaseDocuments/packageUnitMismatch";
import { resolveVendorPurchasePackages } from "@/app/lib/purchaseDocuments/resolveVendorPurchasePackage";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface AiProposedPurchaseUnit {
  vendorPurchaseUnitCode: string | null;
  receivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor: number | null;
}

export interface LineClassificationRow {
  classificationId: string | null;
  lineKey: string;
  lineNumber: number;
  vendorSku: string | null;
  description: string | null;
  status: "PENDING_REVIEW" | "CONFIRMED" | "STALE" | "UNCLASSIFIED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  resolutionSource: string | null;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  aiSuggestedInventoryItemId: string | null;
  aiSuggestedInventoryItemName: string | null;
  aiSuggestedIsNewProposal: boolean;
  aiConfidence: number | null;
  aiProposedPurchaseUnit: AiProposedPurchaseUnit | null;
  /** Only set when aiSuggestedIsNewProposal -- the pending item's OWN
   * best-effort-resolved fields (set at proposal time by
   * record_ai_item_proposal), which is the AI's actual recommendation for
   * a brand new item: name, disposition, category, base unit, spend
   * category. Never re-derived from free text here. */
  aiNewItemProposal: {
    disposition: "INVENTORY" | "NON_INVENTORY";
    categoryId: string | null;
    baseUnitCode: string | null;
    spendCategoryId: string | null;
  } | null;
  // ---- Receiving UX pass additions (Part 12/13/54): direct inline
  // display on Confirm Items, no second "View All Item Mappings" page.
  // All fields below are extensions of the SAME existing query -- no new
  // read model, no denormalized copy.
  /** Source-side context (from purchase_document_lines) -- what the
   * vendor actually invoiced, for verifying a match at a glance. */
  packageQuantity: number | null;
  packageUnit: string | null;
  measuredQuantity: number | null;
  measuredUnit: string | null;
  lineTotal: number | null;
  /** Resolution-side context for a CONFIRMED INVENTORY line -- resolved
   * directly from the same inventory_items join every other field here
   * already uses, never a second lookup. */
  inventoryItemNumber: string | null;
  inventoryCategoryName: string | null;
  inventoryBaseUnitCode: string | null;
  /** Whether the CONFIRMED item was itself created via an AI proposal
   * (durable, set once at creation -- unlike approval_status, which flips
   * to CONFIRMED and can no longer distinguish "was this a new-item
   * proposal" after approval). Used to truthfully label "New Item ·
   * Manager Approved" without guessing. */
  inventoryItemCreatedVia: "MANUAL" | "AI_PROPOSED" | null;
  /** purchase_document_line_classifications' OWN spend_category_id --
   * present for a CONFIRMED NON_INVENTORY line regardless of whether the
   * underlying item join resolves; resolved to a display path client-side
   * from the already-loaded spend-category list (flattenSpendCategoryPaths),
   * never a second server round trip. */
  spendCategoryId: string | null;
  // ---- Purchase-package mismatch surfaced during review (fix for a
  // confirmed defect: this used to only appear at "Ready to Post" time).
  // Mirrors post_purchase_document_inventory's own blocker scan
  // (20260811100123) exactly: the confirmed vendor/SKU purchase package
  // (or the item's base unit, for SAME_UNIT) is resolved from THIS
  // classification's own vendor_item_purchase_unit_id, never a shared
  // per-item default.
  /** The confirmed purchase package's unit code, or the base unit code
   * when there is no distinct vendor package (SAME_UNIT). Null only when
   * disposition isn't CONFIRMED INVENTORY yet. */
  effectivePurchaseUnitCode: string | null;
  effectivePurchaseUnitName: string | null;
  effectiveReceivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  effectiveConversionFactor: number | null;
  /** The raw invoice-extracted packageUnit text, resolved against the real
   * units table (case/whitespace-insensitive) -- null when it doesn't
   * match any recognized unit code, in which case hasPackageMismatch is
   * always false (an unrecognized unit is a different, separately-
   * surfaced concern, never guessed into a false mismatch here). */
  resolvedInvoiceUnitCode: string | null;
  /** True exactly when the resolved invoice unit and the effective
   * purchase package disagree -- see packageUnitMismatch.ts. The line
   * stays CONFIRMED (its item match is correct) but must not count as
   * fully resolved until this clears. */
  hasPackageMismatch: boolean;
}

export type GetPurchaseDocumentLineClassificationsResult = { ok: true; lines: LineClassificationRow[] } | AuthFailure;

/** The Item Mapping panel's read model -- one row per CURRENT line, left-
 * joined to its classification (if any). A line with no classification row
 * shows status UNCLASSIFIED, which is exactly the same "needs a run"
 * signal getLinesNeedingClassification uses internally. */
export async function getPurchaseDocumentLineClassifications(purchaseDocumentId: string): Promise<GetPurchaseDocumentLineClassificationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const [{ data: lines }, { data: classifications }, { data: allUnits }, { data: purchaseDocument }] = await Promise.all([
    supabase
      .from("purchase_document_lines")
      .select("line_key, line_number, vendor_sku, description, package_quantity, package_unit, measured_quantity, measured_unit, line_total")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", auth.manager.organizationId)
      .order("line_number"),
    supabase
      .from("purchase_document_line_classifications")
      .select(
        "id, line_key, status, disposition, resolution_source, ai_confidence, ai_proposed_purchase_unit, inventory_item_id, ai_suggested_inventory_item_id, spend_category_id, vendor_item_purchase_unit_id, inventory_items!purchase_document_line_classifications_item_org_fk(id, name, item_number, created_via, base_unit_id, inventory_categories(name), units(code, name)), ai_item:inventory_items!purchase_document_line_classifications_ai_item_org_fk(id, name, approval_status, disposition, category_id, spend_category_id, units(code))"
      )
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", auth.manager.organizationId),
    // Units are a small, global (non-org-scoped) table -- fetched once so
    // the raw invoice-extracted packageUnit TEXT can be resolved against a
    // real recognized unit code before ever being compared to the
    // confirmed purchase package, exactly mirroring how
    // post_purchase_document_inventory itself resolves the received unit
    // (never a raw string compare against unverified OCR text).
    supabase.from("units").select("code"),
    supabase.from("purchase_documents").select("vendor_id").eq("id", purchaseDocumentId).eq("organization_id", auth.manager.organizationId).maybeSingle(),
  ]);

  const recognizedUnitCodes = new Set((allUnits ?? []).map((u) => (u.code as string).trim().toUpperCase()));

  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));

  // Resolves the effective vendor purchase package with the SAME 3-layer
  // priority Step 3 (getReceivingLines.ts) uses -- see
  // resolveVendorPurchasePackage.ts's own doc comment. Layer 1 (this
  // classification's own vendor_item_purchase_unit_id) alone silently
  // missed every VENDOR_SKU_MAPPING-auto-classified repeat line (the
  // common case for a returning vendor/SKU) and every item whose original
  // approval predated full vendor-package-model adoption -- exactly the
  // real Bartlett/Farmland Sour Cream case (confirmed package "PACK, 1
  // PACK = 10 LB" lives only in the legacy inventory_item_units +
  // vendor_item_mappings.confirmed_invoice_unit_id tables for that item).
  const vendorPackageByLineKey = await resolveVendorPurchasePackages(
    supabase,
    auth.manager.organizationId,
    (purchaseDocument?.vendor_id as string | null) ?? null,
    (classifications ?? [])
      .filter((c) => c.status === "CONFIRMED" && c.disposition === "INVENTORY" && c.inventory_item_id)
      .map((c) => ({ key: c.line_key as string, inventoryItemId: c.inventory_item_id as string, vendorItemPurchaseUnitId: c.vendor_item_purchase_unit_id as string | null }))
  );

  const rows: LineClassificationRow[] = (lines ?? []).map((line) => {
    const c = classificationByLineKey.get(line.line_key as string);
    if (!c) {
      return {
        classificationId: null,
        lineKey: line.line_key as string,
        lineNumber: line.line_number as number,
        vendorSku: line.vendor_sku as string | null,
        description: line.description as string | null,
        status: "UNCLASSIFIED",
        disposition: "UNRESOLVED",
        resolutionSource: null,
        inventoryItemId: null,
        inventoryItemName: null,
        aiSuggestedInventoryItemId: null,
        aiSuggestedInventoryItemName: null,
        aiSuggestedIsNewProposal: false,
        aiConfidence: null,
        aiProposedPurchaseUnit: null,
        aiNewItemProposal: null,
        packageQuantity: line.package_quantity as number | null,
        packageUnit: line.package_unit as string | null,
        measuredQuantity: line.measured_quantity as number | null,
        measuredUnit: line.measured_unit as string | null,
        lineTotal: line.line_total as number | null,
        inventoryItemNumber: null,
        inventoryCategoryName: null,
        inventoryBaseUnitCode: null,
        inventoryItemCreatedVia: null,
        spendCategoryId: null,
        effectivePurchaseUnitCode: null,
        effectivePurchaseUnitName: null,
        effectiveReceivingBehavior: null,
        effectiveConversionFactor: null,
        resolvedInvoiceUnitCode: resolveUnitCode(line.package_unit as string | null, recognizedUnitCodes),
        hasPackageMismatch: false,
      };
    }

    const item = Array.isArray(c.inventory_items) ? c.inventory_items[0] : c.inventory_items;
    const itemCategory = item ? (Array.isArray(item.inventory_categories) ? item.inventory_categories[0] : item.inventory_categories) : null;
    const itemUnit = item ? (Array.isArray(item.units) ? item.units[0] : item.units) : null;
    const aiItem = Array.isArray(c.ai_item) ? c.ai_item[0] : c.ai_item;
    const aiItemUnit = aiItem ? (Array.isArray(aiItem.units) ? aiItem.units[0] : aiItem.units) : null;
    const isNewProposal = aiItem?.approval_status === "PENDING_REVIEW";

    // Purchase-package mismatch (see packageUnitMismatch.ts): the
    // effective purchase package comes from THIS line's own resolved
    // vendor package (see resolveVendorPurchasePackages' 3-layer priority
    // above), falling back to the item's base unit for SAME_UNIT --
    // exactly coalesce(vpu.purchase_unit_id, ii.base_unit_id) in
    // post_purchase_document_inventory.
    const vendorPackage = vendorPackageByLineKey.get(line.line_key as string) ?? null;
    const status = c.status as "PENDING_REVIEW" | "CONFIRMED" | "STALE";
    const disposition = c.disposition as "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
    const {
      effectivePurchaseUnitCode,
      effectivePurchaseUnitName,
      effectiveReceivingBehavior,
      effectiveConversionFactor,
      resolvedInvoiceUnitCode,
      hasPackageMismatch,
    } = resolveLineMismatchFields({
      status,
      disposition,
      invoicePackageUnitText: line.package_unit as string | null,
      vendorPackage,
      itemBaseUnit: itemUnit ? { code: (itemUnit.code as string | undefined) ?? null, name: (itemUnit.name as string | undefined) ?? null } : null,
      recognizedUnitCodes,
    });

    return {
      classificationId: c.id as string,
      lineKey: line.line_key as string,
      lineNumber: line.line_number as number,
      vendorSku: line.vendor_sku as string | null,
      description: line.description as string | null,
      status: c.status as "PENDING_REVIEW" | "CONFIRMED" | "STALE",
      disposition: c.disposition as "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED",
      resolutionSource: c.resolution_source as string | null,
      inventoryItemId: (item?.id as string | undefined) ?? null,
      inventoryItemName: (item?.name as string | undefined) ?? null,
      aiSuggestedInventoryItemId: (aiItem?.id as string | undefined) ?? null,
      aiSuggestedInventoryItemName: (aiItem?.name as string | undefined) ?? null,
      aiSuggestedIsNewProposal: isNewProposal,
      aiConfidence: c.ai_confidence as number | null,
      aiProposedPurchaseUnit: (c.ai_proposed_purchase_unit as AiProposedPurchaseUnit | null) ?? null,
      packageQuantity: line.package_quantity as number | null,
      packageUnit: line.package_unit as string | null,
      measuredQuantity: line.measured_quantity as number | null,
      measuredUnit: line.measured_unit as string | null,
      lineTotal: line.line_total as number | null,
      inventoryItemNumber: (item?.item_number as string | null | undefined) ?? null,
      inventoryCategoryName: (itemCategory?.name as string | undefined) ?? null,
      inventoryBaseUnitCode: (itemUnit?.code as string | undefined) ?? null,
      inventoryItemCreatedVia: (item?.created_via as "MANUAL" | "AI_PROPOSED" | null | undefined) ?? null,
      spendCategoryId: (c.spend_category_id as string | null | undefined) ?? null,
      effectivePurchaseUnitCode,
      effectivePurchaseUnitName,
      effectiveReceivingBehavior,
      effectiveConversionFactor,
      resolvedInvoiceUnitCode,
      hasPackageMismatch,
      aiNewItemProposal: isNewProposal
        ? {
            disposition: (aiItem?.disposition as "INVENTORY" | "NON_INVENTORY" | undefined) ?? "INVENTORY",
            categoryId: (aiItem?.category_id as string | null | undefined) ?? null,
            baseUnitCode: (aiItemUnit?.code as string | undefined) ?? null,
            spendCategoryId: (aiItem?.spend_category_id as string | null | undefined) ?? null,
          }
        : null,
    };
  });

  return { ok: true, lines: rows };
}

export type RunItemMatchingNowResult = { ok: true } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** The manual "Run Item Matching" button -- always visible, always safe to
 * click; concurrency is fully owned by the claim RPC inside the
 * orchestrator, so a click that races an in-flight auto-run just observes
 * ALREADY_RUNNING and returns immediately. Synchronous (not after()-
 * scheduled) so the UI's section-level processing state can await it.
 *
 * This is also the one path allowed to refresh a PENDING_REVIEW line whose
 * current proposal came from AI (includeUnconfirmedAiProposals) -- a
 * manager explicitly clicking this button is exactly the "manager-
 * initiated, not automatic" refresh the safety rules require. A CONFIRMED
 * line is never touched regardless (enforced independently by both
 * getLinesNeedingClassification and record_ai_item_proposal itself). */
export async function runItemMatchingNow(purchaseDocumentId: string): Promise<RunItemMatchingNowResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await classifyPurchaseDocumentLines(purchaseDocumentId, auth.manager.organizationId, { includeUnconfirmedAiProposals: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not run item matching. Try again." };
  }
}

export type EnsureItemMatchingStartedResult = { ok: true } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** Step 2's own automatic (never manager-initiated) safety net -- covers
 * the narrow race where the manager reaches Confirm Items before the
 * after()-scheduled classification run from the save that got them there
 * has actually started. Deliberately NOT runItemMatchingNow: that action's
 * includeUnconfirmedAiProposals=true is reserved for an explicit manual
 * "Re-run Matching" click, never fired automatically (a manager reviewing
 * an already-PENDING_REVIEW proposal must never have it silently swapped
 * out from under them just because they loaded the page). This call is a
 * no-op whenever nothing needs classifying or another run already has it
 * claimed -- concurrency is fully owned by the same claim RPC either way. */
export async function ensureItemMatchingStarted(purchaseDocumentId: string): Promise<EnsureItemMatchingStartedResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await classifyPurchaseDocumentLines(purchaseDocumentId, auth.manager.organizationId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not run item matching. Try again." };
  }
}

export type GetClassificationMatchingStatusResult =
  | { ok: true; active: boolean; outcome: "SUCCEEDED" | "FAILED" | "ABANDONED" | null }
  | AuthFailure;

/** The read-only signal Step 2's blocking "Matching Items" state polls --
 * whether the most recent classification run for this document is still
 * claimed-but-unfinished. Never claims or mutates anything itself. */
export async function getClassificationMatchingStatus(purchaseDocumentId: string): Promise<GetClassificationMatchingStatusResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const status = await getClassificationRunStatus(getServiceRoleClient(), purchaseDocumentId, auth.manager.organizationId);
  return { ok: true, ...status };
}

export interface ApproveNewItemClassificationInput {
  purchaseDocumentId: string;
  lineKey: string;
  finalName: string;
  disposition: "INVENTORY" | "NON_INVENTORY";
  categoryId: string | null;
  spendCategoryId: string | null;
  baseUnitCode: string | null;
  pendingItemId?: string | null;
  rememberVendorMapping?: boolean;
  purchaseUnitCode?: string | null;
  receivingBehavior?: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor?: number | null;
  secondaryUsageUnitCode?: string | null;
  secondaryConversionFactor?: number | null;
  secondaryRequiresMeasurement?: boolean;
}

export type ApproveClassificationResult =
  | { ok: true; inventoryItemId: string }
  | AuthFailure
  | {
      ok: false;
      reason: "line_not_found" | "not_pending" | "not_preparer" | "duplicate_item_name" | "line_conflict" | "invalid_usage_unit" | "misconfigured";
      message: string;
      existingItemId?: string | null;
      existingItemName?: string | null;
    };

export async function approveNewItemClassification(input: ApproveNewItemClassificationInput): Promise<ApproveClassificationResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await approveLineClassificationNewItemRpc(getServiceRoleClient(), {
      purchaseDocumentId: input.purchaseDocumentId,
      lineKey: input.lineKey,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      finalName: input.finalName,
      disposition: input.disposition,
      categoryId: input.categoryId,
      spendCategoryId: input.spendCategoryId,
      baseUnitCode: input.baseUnitCode,
      pendingItemId: input.pendingItemId,
      rememberVendorMapping: input.rememberVendorMapping,
      purchaseUnitCode: input.purchaseUnitCode,
      receivingBehavior: input.receivingBehavior,
      fixedConversionFactor: input.fixedConversionFactor,
      secondaryUsageUnitCode: input.secondaryUsageUnitCode,
      secondaryConversionFactor: input.secondaryConversionFactor,
      secondaryRequiresMeasurement: input.secondaryRequiresMeasurement,
    });
    return { ok: true, inventoryItemId: result.inventoryItemId };
  } catch (err) {
    return mapClassificationApprovalError(err);
  }
}

export interface ApproveExistingItemClassificationInput {
  purchaseDocumentId: string;
  lineKey: string;
  inventoryItemId: string;
  rememberVendorMapping?: boolean;
  purchaseUnitCode?: string | null;
  receivingBehavior?: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor?: number | null;
}

export async function approveExistingItemClassification(input: ApproveExistingItemClassificationInput): Promise<ApproveClassificationResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await approveLineClassificationExistingItemRpc(getServiceRoleClient(), {
      purchaseDocumentId: input.purchaseDocumentId,
      lineKey: input.lineKey,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      inventoryItemId: input.inventoryItemId,
      rememberVendorMapping: input.rememberVendorMapping,
      purchaseUnitCode: input.purchaseUnitCode,
      receivingBehavior: input.receivingBehavior,
      fixedConversionFactor: input.fixedConversionFactor,
    });
    return { ok: true, inventoryItemId: input.inventoryItemId };
  } catch (err) {
    return mapClassificationApprovalError(err);
  }
}

/** A quick, one-click way to dispose of a line that is genuinely not
 * inventory (freight, fuel surcharge, a service fee) without walking
 * through the full new-item form -- still creates (or reuses, via
 * pendingItemId) a real Item Master row, since NON_INVENTORY is a
 * disposition, not a bypass of the domain model. */
export async function markLineNonInventory(
  purchaseDocumentId: string,
  lineKey: string,
  finalName: string,
  pendingItemId?: string | null
): Promise<ApproveClassificationResult> {
  return approveNewItemClassification({
    purchaseDocumentId,
    lineKey,
    finalName,
    disposition: "NON_INVENTORY",
    categoryId: null,
    spendCategoryId: null,
    baseUnitCode: null,
    pendingItemId,
    rememberVendorMapping: true,
  });
}

export type BulkConfirmClassificationsResult = { ok: true; confirmedIds: string[] } | AuthFailure | { ok: false; reason: "misconfigured"; message: string };

/** Existing-item AI matches only -- never offered for new-item proposals. */
export async function bulkConfirmClassifications(classificationIds: string[]): Promise<BulkConfirmClassificationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const confirmedIds = await bulkConfirmLineClassificationsRpc(getServiceRoleClient(), {
      classificationIds,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
    });
    return { ok: true, confirmedIds };
  } catch {
    return { ok: false, reason: "misconfigured", message: "Could not confirm the selected lines. Try again." };
  }
}

export type ListUnresolvedClassificationsResult = { ok: true; lines: UnresolvedClassificationRow[] } | AuthFailure;

/** The org-wide recovery queue behind /manager/items/review -- every
 * CURRENT PENDING_REVIEW/STALE line across every purchase document, never
 * an intentionally-retained orphaned historical row (see
 * listUnresolvedClassifications for the exact set-based check). */
export async function listUnresolvedClassificationsForReview(): Promise<ListUnresolvedClassificationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const lines = await listUnresolvedClassifications(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, lines };
}

function mapClassificationApprovalError(err: unknown): ApproveClassificationResult {
  if (err instanceof LineNotFoundInCurrentRevisionError) {
    return { ok: false, reason: "line_not_found", message: "This line no longer exists on the current revision. Reload and try again." };
  }
  if (err instanceof ItemNotPendingReviewError) {
    return { ok: false, reason: "not_pending", message: "That item is not a confirmed Item Master entry." };
  }
  if (err instanceof NotPreparerError) {
    return { ok: false, reason: "not_preparer", message: "Only this draft's preparer can approve item classifications on it." };
  }
  if (err instanceof DuplicateItemNameError) {
    return {
      ok: false,
      reason: "duplicate_item_name",
      message: err.existingItemName
        ? `An active item named "${err.existingItemName}" already exists -- use it instead of creating a duplicate.`
        : "An active item with this name already exists -- use it instead of creating a duplicate.",
      existingItemId: err.existingItemId,
      existingItemName: err.existingItemName,
    };
  }
  if (err instanceof LineAlreadyConfirmedAgainstDifferentItemError) {
    return { ok: false, reason: "line_conflict", message: "This line was already confirmed against a different item. Reload the page and try again." };
  }
  if (err instanceof InvalidUsageUnitConfigurationError || err instanceof NonInventoryItemUsageUnitError) {
    return { ok: false, reason: "invalid_usage_unit", message: err.message };
  }
  return { ok: false, reason: "misconfigured", message: "Could not approve this classification. Try again." };
}
