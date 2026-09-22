import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";
import { mapInventoryRpcError, INVENTORY_SQLSTATE } from "@/app/lib/inventory/errors";
import type { CreditSubtype, DiscountScope, LineTreatment } from "@/app/lib/purchaseDocuments/lineTreatment";

/**
 * Typed wrappers around the line-treatment RPCs (20260811100182). Every
 * validation lives in the database (org isolation, active category,
 * required credit subtype, storage-eligible location, negative-stock
 * check, preparer/permission guards); these wrappers only map codes.
 */

function mapTreatmentError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code && (Object.values(INVENTORY_SQLSTATE) as string[]).includes(error.code)) {
    // GA021 (invalid location) / GA022 (insufficient inventory) come from
    // the inventory domain and carry their own typed classes.
    return mapInventoryRpcError(error);
  }
  const mapped = mapPurchaseDocumentRpcError(error);
  if (mapped.constructor === Error) return mapItemMasterRpcError(error);
  return mapped;
}

export interface RecordAiLineTreatmentInput {
  organizationId: string;
  purchaseDocumentId: string;
  lineKey: string;
  proposedTreatment: LineTreatment;
  proposedCreditSubtype: CreditSubtype | null;
  proposedSpendCategoryId: string | null;
  proposedDiscountScope: DiscountScope | null;
  confidence: number | null;
  reason: string | null;
  evidence: string[];
  fieldsRequiringReview: string[];
  resolutionSource: "AI_SUGGESTED" | "VENDOR_TREATMENT_RULE";
  treatmentRuleId: string | null;
}

/** SYSTEM writer -- never confirms; applies the confidence policy in the
 * database (see record_ai_line_treatment). */
export async function recordAiLineTreatmentRpc(supabase: SupabaseClient, input: RecordAiLineTreatmentInput): Promise<{ classificationId: string; appliedTreatment: LineTreatment | null }> {
  const { data, error } = await supabase.rpc("record_ai_line_treatment", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_proposed_treatment: input.proposedTreatment,
    p_proposed_credit_subtype: input.proposedCreditSubtype,
    p_proposed_spend_category_id: input.proposedSpendCategoryId,
    p_ai_confidence: input.confidence,
    p_ai_reason: input.reason,
    p_ai_evidence: input.evidence,
    p_ai_review_fields: input.fieldsRequiringReview,
    p_resolution_source: input.resolutionSource,
    p_treatment_rule_id: input.treatmentRuleId,
    p_discount_scope: input.proposedDiscountScope,
  });
  if (error) throw mapTreatmentError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_classification_id: string; out_applied_treatment: string | null } | undefined;
  if (!row) throw new Error("record_ai_line_treatment returned no result row");
  return { classificationId: row.out_classification_id, appliedTreatment: (row.out_applied_treatment as LineTreatment | null) ?? null };
}

export interface VendorLineTreatmentRuleMatch {
  ruleId: string;
  lineTreatment: LineTreatment;
  creditSubtype: CreditSubtype | null;
  spendCategoryId: string | null;
  discountScope: DiscountScope | null;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
}

export async function findVendorLineTreatmentRuleRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; vendorId: string; vendorSku: string | null; description: string | null }
): Promise<VendorLineTreatmentRuleMatch | null> {
  const { data, error } = await supabase.rpc("find_vendor_line_treatment_rule", {
    p_organization_id: input.organizationId,
    p_vendor_id: input.vendorId,
    p_vendor_sku: input.vendorSku,
    p_description: input.description,
  });
  if (error) throw mapTreatmentError(error);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_rule_id: string; out_line_treatment: string; out_credit_subtype: string | null; out_spend_category_id: string | null; out_discount_scope: string | null; out_match_basis: string }
    | undefined;
  if (!row) return null;
  return {
    ruleId: row.out_rule_id,
    lineTreatment: row.out_line_treatment as LineTreatment,
    creditSubtype: (row.out_credit_subtype as CreditSubtype | null) ?? null,
    spendCategoryId: row.out_spend_category_id,
    discountScope: (row.out_discount_scope as DiscountScope | null) ?? null,
    matchBasis: row.out_match_basis as "VENDOR_SKU" | "NORMALIZED_DESCRIPTION",
  };
}

export interface SetLineTreatmentInput {
  organizationId: string;
  appUserId: string;
  purchaseDocumentId: string;
  lineKey: string;
  lineTreatment: LineTreatment;
  creditSubtype?: CreditSubtype | null;
  spendCategoryId?: string | null;
  explanation?: string | null;
  discountScope?: DiscountScope | null;
  discountRelatedLineKey?: string | null;
  returnInventoryItemId?: string | null;
  returnQuantity?: number | null;
  returnUnitCode?: string | null;
  returnLocationId?: string | null;
  returnReason?: string | null;
  returnImpactAcknowledged?: boolean;
  rememberVendorRule?: boolean;
}

export async function setLineTreatmentRpc(
  supabase: SupabaseClient,
  input: SetLineTreatmentInput
): Promise<{ classificationId: string; status: "CONFIRMED" | "PENDING_REVIEW"; ruleId: string | null }> {
  const { data, error } = await supabase.rpc("set_purchase_document_line_treatment", {
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_line_treatment: input.lineTreatment,
    p_credit_subtype: input.creditSubtype ?? null,
    p_spend_category_id: input.spendCategoryId ?? null,
    p_explanation: input.explanation ?? null,
    p_discount_scope: input.discountScope ?? null,
    p_discount_related_line_key: input.discountRelatedLineKey ?? null,
    p_return_inventory_item_id: input.returnInventoryItemId ?? null,
    p_return_quantity: input.returnQuantity ?? null,
    p_return_unit_code: input.returnUnitCode ?? null,
    p_return_location_id: input.returnLocationId ?? null,
    p_return_reason: input.returnReason ?? null,
    p_return_impact_acknowledged: input.returnImpactAcknowledged ?? false,
    p_remember_vendor_rule: input.rememberVendorRule ?? false,
  });
  if (error) throw mapTreatmentError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_classification_id: string; out_status: string; out_rule_id: string | null } | undefined;
  if (!row) throw new Error("set_purchase_document_line_treatment returned no result row");
  return { classificationId: row.out_classification_id, status: row.out_status as "CONFIRMED" | "PENDING_REVIEW", ruleId: row.out_rule_id };
}

export async function acceptAiAssignedLineClassificationsRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; purchaseDocumentId: string; appUserId: string }
): Promise<number> {
  const { data, error } = await supabase.rpc("accept_ai_assigned_line_classifications", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_app_user_id: input.appUserId,
  });
  if (error) throw mapTreatmentError(error);
  return Number(data ?? 0);
}

export interface VendorLineTreatmentRuleSummary {
  ruleId: string;
  vendorId: string;
  vendorName: string;
  vendorSku: string | null;
  normalizedDescription: string | null;
  lineTreatment: LineTreatment;
  creditSubtype: CreditSubtype | null;
  spendCategoryId: string | null;
  spendCategoryName: string | null;
  spendCategoryIsActive: boolean | null;
  discountScope: DiscountScope | null;
  isActive: boolean;
  createdByName: string | null;
  createdAt: string;
  sourcePurchaseDocumentId: string | null;
  matchCount: number;
}

export async function listVendorLineTreatmentRulesRpc(supabase: SupabaseClient, organizationId: string): Promise<VendorLineTreatmentRuleSummary[]> {
  const { data, error } = await supabase.rpc("list_vendor_line_treatment_rules", { p_organization_id: organizationId });
  if (error) throw mapTreatmentError(error);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    ruleId: r.out_id as string,
    vendorId: r.out_vendor_id as string,
    vendorName: r.out_vendor_name as string,
    vendorSku: (r.out_vendor_sku as string | null) ?? null,
    normalizedDescription: (r.out_normalized_description as string | null) ?? null,
    lineTreatment: r.out_line_treatment as LineTreatment,
    creditSubtype: (r.out_credit_subtype as CreditSubtype | null) ?? null,
    spendCategoryId: (r.out_spend_category_id as string | null) ?? null,
    spendCategoryName: (r.out_spend_category_name as string | null) ?? null,
    spendCategoryIsActive: (r.out_spend_category_is_active as boolean | null) ?? null,
    discountScope: (r.out_discount_scope as DiscountScope | null) ?? null,
    isActive: r.out_is_active as boolean,
    createdByName: (r.out_created_by_name as string | null) ?? null,
    createdAt: r.out_created_at as string,
    sourcePurchaseDocumentId: (r.out_source_purchase_document_id as string | null) ?? null,
    matchCount: Number(r.out_match_count ?? 0),
  }));
}

export async function setVendorLineTreatmentRuleActiveRpc(
  supabase: SupabaseClient,
  input: { organizationId: string; actorAppUserId: string; ruleId: string; isActive: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("set_vendor_line_treatment_rule_active", {
    p_organization_id: input.organizationId,
    p_actor_app_user_id: input.actorAppUserId,
    p_rule_id: input.ruleId,
    p_is_active: input.isActive,
  });
  if (error) throw mapTreatmentError(error);
}
