import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { createVerifiedPostingDocument, getLocationBalance, getPostingStatus } from "./inventoryPostingTestHelpers";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { setLineTreatmentRpc, recordAiLineTreatmentRpc, acceptAiAssignedLineClassificationsRpc, findVendorLineTreatmentRuleRpc, listVendorLineTreatmentRulesRpc, setVendorLineTreatmentRuleActiveRpc } from "@/app/lib/purchaseDocuments/lineTreatmentRpcs";
import { InvalidLineTreatmentError, ExplanationRequiredError, PreparationIncompleteError, NotPreparerError } from "@/app/lib/purchaseDocuments/errors";
import { InsufficientInventoryError } from "@/app/lib/inventory/errors";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";

/**
 * MANUAL / ON-DEMAND ONLY (real linked DEV database, TEST fixture org).
 * Line-treatment model (20260811100182): the database is the authority
 * for every treatment rule, the confidence policy's acceptance, the
 * vendor-rule learning, and posting effects per treatment.
 */

/** An active employee app user with no roles (and so no permissions) --
 * distinct per call so no other suite can have decorated it. */
async function createRoleLessAppUser(supabase: SupabaseClient, organizationId: string): Promise<string> {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper) throw new Error("PIN_PEPPER is not set");
  const code = `TEST-LT-NOROLE-${crypto.randomUUID().slice(0, 8)}`;
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .insert({ organization_id: organizationId, first_name: "TestNoRole", last_name: "TestFixture", employee_code: code, default_station_id: null, auto_resolve_station: false, can_change_station: false, status: "active" })
    .select("id")
    .single();
  if (employeeError) throw employeeError;
  const pin = String(100000 + Math.floor(Math.random() * 900000));
  const { data: appUser, error: appUserError } = await supabase
    .from("app_users")
    .insert({ organization_id: organizationId, employee_id: employee.id as string, pin_lookup_hash: hashPinLookup(pin, pepper), pin_hash: await hashPinForStorage(pin), is_active: true })
    .select("id")
    .single();
  if (appUserError) throw appUserError;
  return appUser.id as string;
}

let fx: RpcTestFixtures;
let otherOrg: Awaited<ReturnType<typeof setupOtherOrgFixtures>>;
let locationId: string;
let spendCategoryId: string;

async function draftWithLines(lines: { vendorSku?: string | null; description: string; packageUnit?: string | null; packageQuantity?: number }[]) {
  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: lines.map((l) => ({ vendorSku: l.vendorSku ?? null, description: l.description, packageUnit: l.packageUnit ?? null, measuredUnit: null, packageQuantity: l.packageQuantity ?? 1 })),
  });
  const lineKeys = await getLineKeys(fx.supabase, purchaseDocumentId);
  return { purchaseDocumentId, documentId, lineKeys };
}

async function setLineTotal(purchaseDocumentId: string, lineKey: string, lineTotal: number) {
  const { error } = await fx.supabase.from("purchase_document_lines").update({ line_total: lineTotal, unit_price: lineTotal }).eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
  if (error) throw new Error(error.message);
}

async function classification(purchaseDocumentId: string, lineKey: string) {
  const { data, error } = await fx.supabase
    .from("purchase_document_line_classifications")
    .select("id, status, disposition, line_treatment, credit_subtype, spend_category_id, inventory_item_id, resolution_source, ai_confidence, treatment_rule_id, explanation")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("line_key", lineKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function preparationIncomplete(purchaseDocumentId: string): Promise<boolean> {
  const { data, error } = await fx.supabase.rpc("purchase_document_preparation_incomplete", { p_purchase_document_id: purchaseDocumentId, p_organization_id: fx.organizationId });
  if (error) throw new Error(error.message);
  return data as boolean;
}

async function postingBlockers(purchaseDocumentId: string): Promise<{ out_line_key: string; out_reason: string }[]> {
  const { data, error } = await fx.supabase.rpc("get_purchase_document_posting_blockers", { p_purchase_document_id: purchaseDocumentId, p_organization_id: fx.organizationId });
  if (error) throw new Error(error.message);
  return (data ?? []) as { out_line_key: string; out_reason: string }[];
}

async function submitAndVerify(purchaseDocumentId: string): Promise<number> {
  const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 });
  await verifyPurchaseDocumentRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId, expectedVersion: submitted.version });
  return submitted.version + 1;
}

async function countMovements(purchaseDocumentId: string): Promise<number> {
  const { data: postings } = await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", purchaseDocumentId);
  const ids = (postings ?? []).map((p) => p.id as string);
  if (ids.length === 0) return 0;
  const [{ count: receipt }, { count: ret }] = await Promise.all([
    fx.supabase.from("purchase_document_inventory_posting_lines").select("id", { count: "exact", head: true }).in("posting_id", ids),
    fx.supabase.from("purchase_document_inventory_return_lines").select("id", { count: "exact", head: true }).in("posting_id", ids),
  ]);
  return (receipt ?? 0) + (ret ?? 0);
}

async function createCategory(supabase: SupabaseClient, organizationId: string, name: string, requiresExplanation = false): Promise<string> {
  const { data, error } = await supabase.rpc("create_spend_category", { p_organization_id: organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_name: name });
  if (error) throw new Error(error.message);
  const id = ((Array.isArray(data) ? data[0] : data) as { out_category_id: string }).out_category_id;
  if (requiresExplanation) await supabase.from("spend_categories").update({ requires_explanation: true }).eq("id", id);
  return id;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = loc!.id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

describe("AI / rule writer + confidence policy", () => {
  it("test 2/3: a high-confidence expense with a valid category is preselected, then accepted as the manager's decision on continue", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "WALK-IN COMPRESSOR REPAIR" }]);
    await setLineTotal(purchaseDocumentId, lineKeys[0], 425);
    const written = await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[0],
      proposedTreatment: "EXPENSE", proposedCreditSubtype: null, proposedSpendCategoryId: spendCategoryId, proposedDiscountScope: null,
      confidence: 0.97, reason: "Service/repair, not a product.", evidence: ["keyword REPAIR"], fieldsRequiringReview: [], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    expect(written.appliedTreatment).toBe("EXPENSE");
    const before = await classification(purchaseDocumentId, lineKeys[0]);
    expect(before).toMatchObject({ status: "PENDING_REVIEW", line_treatment: "EXPENSE", disposition: "NON_INVENTORY", spend_category_id: spendCategoryId, inventory_item_id: null });
    expect((await postingBlockers(purchaseDocumentId)).filter((b) => b.out_line_key === lineKeys[0])).toEqual([]);

    const accepted = await acceptAiAssignedLineClassificationsRpc(fx.supabase, { organizationId: fx.organizationId, purchaseDocumentId, appUserId: fx.changeableEmployeeAppUserId });
    expect(accepted).toBe(1);
    const after = await classification(purchaseDocumentId, lineKeys[0]);
    expect(after).toMatchObject({ status: "CONFIRMED", resolution_source: "AI_ACCEPTED", spend_category_id: spendCategoryId });
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(false);
  });

  it("test 4: an invalid / foreign / inactive category id is never saved -- the line lands UNRESOLVED", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "MISC SERVICE" }, { description: "OTHER SERVICE" }]);
    const foreign = await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[0],
      proposedTreatment: "EXPENSE", proposedCreditSubtype: null, proposedSpendCategoryId: crypto.randomUUID(), proposedDiscountScope: null,
      confidence: 0.99, reason: null, evidence: [], fieldsRequiringReview: [], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    expect(foreign.appliedTreatment).toBe("UNRESOLVED");
    expect(await classification(purchaseDocumentId, lineKeys[0])).toMatchObject({ line_treatment: "UNRESOLVED", disposition: "UNRESOLVED", spend_category_id: null });

    const inactiveId = await createCategory(fx.supabase, fx.organizationId, `TEST Inactive ${crypto.randomUUID().slice(0, 6)}`);
    await fx.supabase.rpc("set_spend_category_active", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: inactiveId, p_is_active: false });
    const inactive = await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[1],
      proposedTreatment: "EXPENSE", proposedCreditSubtype: null, proposedSpendCategoryId: inactiveId, proposedDiscountScope: null,
      confidence: 0.99, reason: null, evidence: [], fieldsRequiringReview: [], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    expect(inactive.appliedTreatment).toBe("UNRESOLVED");
  });

  it("test 15/16: a low-confidence line stays UNRESOLVED and blocks submission; a medium-confidence one is not auto-accepted", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "MISC CHG / RTN 4" }, { description: "DELIVERY CHARGE" }]);
    const low = await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[0],
      proposedTreatment: "CREDIT_RETURN", proposedCreditSubtype: null, proposedSpendCategoryId: null, proposedDiscountScope: null,
      confidence: 0.43, reason: "Unclear.", evidence: [], fieldsRequiringReview: ["treatment"], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    expect(low.appliedTreatment).toBe("UNRESOLVED");
    await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[1],
      proposedTreatment: "FREIGHT_FEE", proposedCreditSubtype: null, proposedSpendCategoryId: spendCategoryId, proposedDiscountScope: null,
      confidence: 0.8, reason: null, evidence: [], fieldsRequiringReview: [], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    expect(await acceptAiAssignedLineClassificationsRpc(fx.supabase, { organizationId: fx.organizationId, purchaseDocumentId, appUserId: fx.changeableEmployeeAppUserId })).toBe(0);
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(true);
    const blockers = await postingBlockers(purchaseDocumentId);
    expect(blockers.find((b) => b.out_line_key === lineKeys[0])?.out_reason).toMatch(/not been classified/);
    expect(blockers.find((b) => b.out_line_key === lineKeys[1])?.out_reason).toMatch(/awaiting/);
    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 })
    ).rejects.toThrow(PreparationIncompleteError);
  });

  it("test 6: CASES RETURNED never creates an inventory item -- the treatment writer records a credit with no item row", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ vendorSku: "99", description: "CASES RETURNED" }]);
    await setLineTotal(purchaseDocumentId, lineKeys[0], -24);
    const { count: itemsBefore } = await fx.supabase.from("inventory_items").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId).ilike("name", "%cases returned%");
    await recordAiLineTreatmentRpc(fx.supabase, {
      organizationId: fx.organizationId, purchaseDocumentId, lineKey: lineKeys[0],
      proposedTreatment: "CREDIT_RETURN", proposedCreditSubtype: "RETURNABLE_CONTAINER_CREDIT", proposedSpendCategoryId: null, proposedDiscountScope: null,
      confidence: 0.95, reason: "Returned containers.", evidence: ["negative amount", "keyword RETURNED"], fieldsRequiringReview: [], resolutionSource: "AI_SUGGESTED", treatmentRuleId: null,
    });
    const { count: itemsAfter } = await fx.supabase.from("inventory_items").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId).ilike("name", "%cases returned%");
    expect(itemsAfter).toBe(itemsBefore);
    expect(await classification(purchaseDocumentId, lineKeys[0])).toMatchObject({ line_treatment: "CREDIT_RETURN", credit_subtype: "RETURNABLE_CONTAINER_CREDIT", inventory_item_id: null, spend_category_id: null, disposition: "NON_INVENTORY" });
  });
});

describe("manager decision RPC -- validation per treatment", () => {
  it("test 21: the catch-all category requires a note; a normal category does not", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "MISC" }, { description: "MISC 2" }]);
    const catchAll = await createCategory(fx.supabase, fx.organizationId, `TEST Other Expense ${crypto.randomUUID().slice(0, 6)}`, true);
    await expect(setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId: catchAll })).rejects.toThrow(ExplanationRequiredError);
    const ok = await setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId: catchAll, explanation: "One-off inspection" });
    expect(ok.status).toBe("CONFIRMED");
    expect((await classification(purchaseDocumentId, lineKeys[0]))?.explanation).toBe("One-off inspection");
    await expect(setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[1], lineTreatment: "EXPENSE" })).rejects.toThrow(InvalidLineTreatmentError);
  });

  it("test 12/13/14: tax needs no category; freight and vendor fees take their categories; discount needs a scope; credit needs a subtype", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "SALES TAX" }, { description: "FUEL SURCHARGE" }, { description: "SERVICE CHARGE" }, { description: "PROMOTIONAL DISCOUNT" }, { description: "CREDIT" }]);
    const freight = await createCategory(fx.supabase, fx.organizationId, `TEST Freight ${crypto.randomUUID().slice(0, 6)}`);
    const fees = await createCategory(fx.supabase, fx.organizationId, `TEST Vendor Fees ${crypto.randomUUID().slice(0, 6)}`);
    const org = { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId };
    expect((await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[0], lineTreatment: "TAX" })).status).toBe("CONFIRMED");
    expect(await classification(purchaseDocumentId, lineKeys[0])).toMatchObject({ line_treatment: "TAX", spend_category_id: null, inventory_item_id: null });
    expect((await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[1], lineTreatment: "FREIGHT_FEE", spendCategoryId: freight })).status).toBe("CONFIRMED");
    expect((await classification(purchaseDocumentId, lineKeys[1]))?.spend_category_id).toBe(freight);
    expect((await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[2], lineTreatment: "FREIGHT_FEE", spendCategoryId: fees })).status).toBe("CONFIRMED");
    expect((await classification(purchaseDocumentId, lineKeys[2]))?.spend_category_id).toBe(fees);
    await expect(setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[3], lineTreatment: "DISCOUNT" })).rejects.toThrow(InvalidLineTreatmentError);
    expect((await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[3], lineTreatment: "DISCOUNT", discountScope: "DOCUMENT" })).status).toBe("CONFIRMED");
    await expect(setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[4], lineTreatment: "CREDIT_RETURN" })).rejects.toThrow(InvalidLineTreatmentError);
    expect((await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[4], lineTreatment: "CREDIT_RETURN", creditSubtype: "FINANCIAL_CREDIT" })).status).toBe("CONFIRMED");
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(false);
  });

  it("test 19/20: switching Expense -> Inventory clears the category and re-opens matching; Inventory -> Expense creates no inventory", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "SWITCHING LINE" }]);
    const org = { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId };
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId, explanation: "note" });
    const toInventory = await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[0], lineTreatment: "INVENTORY_PURCHASE" });
    expect(toInventory.status).toBe("PENDING_REVIEW");
    expect(await classification(purchaseDocumentId, lineKeys[0])).toMatchObject({ line_treatment: "INVENTORY_PURCHASE", disposition: "INVENTORY", spend_category_id: null, explanation: null, inventory_item_id: null });
    const back = await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId });
    expect(back.status).toBe("CONFIRMED");
    expect(await classification(purchaseDocumentId, lineKeys[0])).toMatchObject({ disposition: "NON_INVENTORY", inventory_item_id: null });
    const { count } = await fx.supabase.from("receipt_lines").select("id", { count: "exact", head: true }).eq("matched_line_key", lineKeys[0]);
    expect(count).toBe(0);
  });

  it("test 29/30: the server rejects a tampered category from another organization and a non-preparer", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "TAMPER" }]);
    const foreignCategory = await findOrCreateThrowawaySpendCategory(fx.supabase, otherOrg.organizationId);
    await expect(setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId: foreignCategory })).rejects.toThrow();
    // A dedicated actor with NO roles at all: the shared fixture users can
    // be granted correct_any_draft by other suites (shared DEV database), so
    // the non-preparer assertion must not depend on their role state.
    const nonPreparer = await createRoleLessAppUser(fx.supabase, fx.organizationId);
    await expect(setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: nonPreparer, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "TAX" })).rejects.toThrow(NotPreparerError);
    expect(await classification(purchaseDocumentId, lineKeys[0])).toBeNull();
  });

  it("test 23: disabling a category invalidates dependent draft lines", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "SOON DISABLED" }]);
    const category = await createCategory(fx.supabase, fx.organizationId, `TEST Disable Me ${crypto.randomUUID().slice(0, 6)}`);
    await setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId: category });
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(false);
    await fx.supabase.rpc("set_spend_category_active", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: category, p_is_active: false });
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(true);
    expect((await postingBlockers(purchaseDocumentId))[0]?.out_reason).toMatch(/no longer active/);
  });
});

describe("vendor-specific learning", () => {
  it("test 22: a remembered decision is org-scoped, matches by SKU, is listable/disable-able by Admin, and is invalidated by a disabled category", async () => {
    const sku = `RULE-${crypto.randomUUID().slice(0, 6)}`;
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ vendorSku: sku, description: "CASES RETURNED" }]);
    const saved = await setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId, lineKey: lineKeys[0], lineTreatment: "CREDIT_RETURN", creditSubtype: "RETURNABLE_CONTAINER_CREDIT", rememberVendorRule: true });
    expect(saved.ruleId).not.toBeNull();
    const match = await findVendorLineTreatmentRuleRpc(fx.supabase, { organizationId: fx.organizationId, vendorId: fx.vendorId, vendorSku: sku, description: "anything" });
    expect(match).toMatchObject({ ruleId: saved.ruleId, lineTreatment: "CREDIT_RETURN", creditSubtype: "RETURNABLE_CONTAINER_CREDIT", matchBasis: "VENDOR_SKU" });
    expect(await findVendorLineTreatmentRuleRpc(fx.supabase, { organizationId: otherOrg.organizationId, vendorId: otherOrg.vendorId, vendorSku: sku, description: "CASES RETURNED" })).toBeNull();
    const { data: audit } = await fx.supabase.from("audit_events").select("action").eq("entity_id", saved.ruleId!).eq("action", "VENDOR_LINE_TREATMENT_RULE_CREATED");
    expect(audit?.length).toBe(1);
    const listed = await listVendorLineTreatmentRulesRpc(fx.supabase, fx.organizationId);
    expect(listed.find((r) => r.ruleId === saved.ruleId)).toMatchObject({ vendorSku: sku, isActive: true });
    expect(await listVendorLineTreatmentRulesRpc(fx.supabase, otherOrg.organizationId)).not.toContainEqual(expect.objectContaining({ ruleId: saved.ruleId }));
    await setVendorLineTreatmentRuleActiveRpc(fx.supabase, { organizationId: fx.organizationId, actorAppUserId: fx.changeableEmployeeAppUserId, ruleId: saved.ruleId!, isActive: false });
    expect(await findVendorLineTreatmentRuleRpc(fx.supabase, { organizationId: fx.organizationId, vendorId: fx.vendorId, vendorSku: sku, description: null })).toBeNull();

    // A category-backed rule is ignored once its category is disabled.
    const category = await createCategory(fx.supabase, fx.organizationId, `TEST Rule Cat ${crypto.randomUUID().slice(0, 6)}`);
    const sku2 = `RULE2-${crypto.randomUUID().slice(0, 6)}`;
    const second = await draftWithLines([{ vendorSku: sku2, description: "FUEL SURCHARGE" }]);
    await setLineTreatmentRpc(fx.supabase, { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId: second.purchaseDocumentId, lineKey: second.lineKeys[0], lineTreatment: "FREIGHT_FEE", spendCategoryId: category, rememberVendorRule: true });
    expect(await findVendorLineTreatmentRuleRpc(fx.supabase, { organizationId: fx.organizationId, vendorId: fx.vendorId, vendorSku: sku2, description: null })).not.toBeNull();
    await fx.supabase.rpc("set_spend_category_active", { p_organization_id: fx.organizationId, p_app_user_id: fx.changeableEmployeeAppUserId, p_category_id: category, p_is_active: false });
    expect(await findVendorLineTreatmentRuleRpc(fx.supabase, { organizationId: fx.organizationId, vendorId: fx.vendorId, vendorSku: sku2, description: null })).toBeNull();
  });
});

describe("posting effects per treatment", () => {
  it("test 5/7/8/11/12/26: an expense/credit/discount/tax-only invoice posts with NO inventory movement (Post invoice)", async () => {
    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "COMPRESSOR REPAIR" }, { vendorSku: "99", description: "CASES RETURNED" }, { description: "VOLUME DISCOUNT" }, { description: "SALES TAX" }, { description: "ACCOUNT CREDIT" }]);
    const org = { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId };
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[0], lineTreatment: "EXPENSE", spendCategoryId });
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[1], lineTreatment: "CREDIT_RETURN", creditSubtype: "RETURNABLE_CONTAINER_CREDIT" });
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[2], lineTreatment: "DISCOUNT", discountScope: "LINE", discountRelatedLineKey: lineKeys[0] });
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[3], lineTreatment: "TAX" });
    await setLineTreatmentRpc(fx.supabase, { ...org, lineKey: lineKeys[4], lineTreatment: "CREDIT_RETURN", creditSubtype: "FINANCIAL_CREDIT" });
    const { count: movementsBefore } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId);
    await submitAndVerify(purchaseDocumentId);
    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId });
    expect(result.status).toBe("NO_INVENTORY_CHANGES");
    expect(result.postedLineCount).toBe(0);
    const { count: movementsAfter } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("organization_id", fx.organizationId);
    expect(movementsAfter).toBe(movementsBefore);
    expect(await countMovements(purchaseDocumentId)).toBe(0);
    const { count: priceEvents } = await fx.supabase.from("purchase_document_inventory_postings").select("id", { count: "exact", head: true }).eq("purchase_document_id", purchaseDocumentId);
    expect(priceEvents).toBe(0);
  });

  it("test 9/10/28: a physical inventory return posts an audited VENDOR_RETURN movement, never below zero, idempotently", async () => {
    // Stock 5 PIECE of a fresh item at the location via a normal receipt.
    const stocked = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [{ description: "Return Stock Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } }]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: stocked.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId });
    const itemId = stocked.itemIds[0]!;
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(5);

    const { purchaseDocumentId, lineKeys } = await draftWithLines([{ description: "RETURNED 2 PC" }]);
    await setLineTotal(purchaseDocumentId, lineKeys[0], -20);
    const org = { organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, purchaseDocumentId };
    const returnInput = { ...org, lineKey: lineKeys[0], lineTreatment: "CREDIT_RETURN" as const, creditSubtype: "INVENTORY_RETURN" as const, returnInventoryItemId: itemId, returnUnitCode: "PIECE", returnLocationId: locationId, returnReason: "Damaged on arrival", returnImpactAcknowledged: true };
    // Negative stock is refused at decision time (GA022)...
    await expect(setLineTreatmentRpc(fx.supabase, { ...returnInput, returnQuantity: 100 })).rejects.toThrow(InsufficientInventoryError);
    // ...and every required field is enforced.
    await expect(setLineTreatmentRpc(fx.supabase, { ...returnInput, returnQuantity: 2, returnImpactAcknowledged: false })).rejects.toThrow(InvalidLineTreatmentError);
    await expect(setLineTreatmentRpc(fx.supabase, { ...returnInput, returnQuantity: 2, returnReason: "" })).rejects.toThrow(InvalidLineTreatmentError);
    const saved = await setLineTreatmentRpc(fx.supabase, { ...returnInput, returnQuantity: 2 });
    expect(saved.status).toBe("CONFIRMED");
    expect(await preparationIncomplete(purchaseDocumentId)).toBe(false);

    await submitAndVerify(purchaseDocumentId);
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId });
    expect(posted.status).toBe("POSTED");
    expect(posted.postedLineCount).toBe(1);
    expect(posted.movementCount).toBe(1);
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(3);
    const { data: returnLine } = await fx.supabase.from("purchase_document_inventory_return_lines").select("posted_base_quantity, movement_id").eq("line_key", lineKeys[0]).single();
    expect(Number(returnLine!.posted_base_quantity)).toBe(2);
    const { data: movement } = await fx.supabase.from("inventory_movements").select("movement_type").eq("id", returnLine!.movement_id as string).single();
    expect(movement!.movement_type).toBe("VENDOR_RETURN");
    const { data: audit } = await fx.supabase.from("audit_events").select("after_state").eq("action", "INVENTORY_RETURN_POSTED").eq("entity_id", itemId).order("occurred_at", { ascending: false }).limit(1);
    expect((audit?.[0]?.after_state as { baseQuantity: number }).baseQuantity).toBe(2);
    expect((await getPostingStatus(fx.supabase, purchaseDocumentId, fx.organizationId)).status).toBe("POSTED");

    // Idempotent: a second (double-click) post converges without moving stock again.
    const again = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId });
    expect(again.status).toBe("ALREADY_POSTED");
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(3);
  });

  it("test 25/27: a mixed invoice posts only its inventory lines (Post invoice & inventory) -- expense and credit lines create nothing", async () => {
    const stocked = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Mixed Inv Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 4, receivedUnit: "PIECE" } },
      { description: "Fuel Surcharge", receiving: null },
    ]);
    // Reclassify the non-inventory line's legacy NON_INVENTORY row: the
    // trigger derived EXPENSE for it (the previous model's only meaning).
    const { data: rows } = await fx.supabase.from("purchase_document_line_classifications").select("line_key, line_treatment, disposition").eq("purchase_document_id", stocked.purchaseDocumentId);
    expect(rows!.find((r) => r.line_key === stocked.lineKeys[1])).toMatchObject({ line_treatment: "EXPENSE", disposition: "NON_INVENTORY" });
    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: stocked.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId });
    expect(result.status).toBe("POSTED");
    expect(result.postedLineCount).toBe(1);
    expect(await getLocationBalance(fx.supabase, fx.organizationId, stocked.itemIds[0]!, locationId)).toBe(4);
  });
});
