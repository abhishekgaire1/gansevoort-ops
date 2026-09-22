import { describe, expect, it } from "vitest";
import { evaluateLineReadiness, summarizeLineReadiness, postPrimaryLabel, isAutoAcceptable, type LineReadinessInput } from "@/app/lib/purchaseDocuments/lineReadiness";

// CI-safe: pure functions. THE single authoritative per-line readiness
// result -- every gate (Step 1 footer, Step 2 groups, Stepper, Step 3
// access, submission) reads this; these tests pin its contract.

function input(overrides: Partial<LineReadinessInput>): LineReadinessInput {
  return {
    lineKey: "line-1",
    status: "CONFIRMED",
    treatment: "EXPENSE",
    creditSubtype: null,
    discountScope: null,
    resolutionSource: "MANUAL",
    aiConfidence: null,
    lineTotal: 425,
    spendCategoryId: "cat-repairs",
    spendCategoryActive: true,
    spendCategoryRequiresExplanation: false,
    explanation: null,
    inventoryItemId: null,
    aiSuggestedInventoryItemId: null,
    aiSuggestedIsNewProposal: false,
    hasPackageMismatch: false,
    receivingReady: null,
    returnQuantity: null,
    returnUnitCode: null,
    returnLocationId: null,
    returnReason: null,
    returnImpactAcknowledged: false,
    returnBaseQuantity: null,
    returnBaseUnitCode: null,
    returnOnHandQuantity: null,
    ...overrides,
  };
}

describe("evaluateLineReadiness -- expenses", () => {
  it("a confirmed expense with an active category is ready, groups as expense, and has no inventory effect (test 5)", () => {
    const r = evaluateLineReadiness(input({}));
    expect(r.ready).toBe(true);
    expect(r.group).toBe("expense");
    expect(r.inventoryEffect.kind).toBe("none");
    expect(r.financialAmount).toBe(425);
  });

  it("a high-confidence AI expense with a valid category is AI-assigned: settled without a click, but flagged acceptable (test 3)", () => {
    const r = evaluateLineReadiness(input({ status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.97 }));
    expect(r.classificationSettled).toBe(true);
    expect(r.acceptable).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.status).toBe("ai_assigned");
    expect(r.aiLabel).toBe("AI assigned");
  });

  it("a medium-confidence AI expense requires confirmation (review recommended)", () => {
    const r = evaluateLineReadiness(input({ status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.8 }));
    expect(r.classificationSettled).toBe(false);
    expect(r.status).toBe("review_recommended");
    expect(r.group).toBe("needs_attention");
  });

  it("a high-confidence expense with NO category is never auto-accepted and needs attention (test 4)", () => {
    const r = evaluateLineReadiness(input({ status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.99, spendCategoryId: null }));
    expect(r.acceptable).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.issues[0]).toMatch(/category is missing/i);
  });

  it("a disabled category invalidates a confirmed expense line (test 23)", () => {
    const r = evaluateLineReadiness(input({ spendCategoryActive: false }));
    expect(r.ready).toBe(false);
    expect(r.issues[0]).toMatch(/no longer active/i);
  });

  it("the catch-all category requires a written note (test 21)", () => {
    expect(evaluateLineReadiness(input({ spendCategoryRequiresExplanation: true, explanation: "" })).ready).toBe(false);
    expect(evaluateLineReadiness(input({ spendCategoryRequiresExplanation: true, explanation: "One-off inspection fee" })).ready).toBe(true);
  });

  it("freight/fee behaves like an expense (tests 13/14)", () => {
    const r = evaluateLineReadiness(input({ treatment: "FREIGHT_FEE", spendCategoryId: "cat-freight" }));
    expect(r.ready).toBe(true);
    expect(r.group).toBe("expense");
    expect(r.inventoryEffect.kind).toBe("none");
  });
});

describe("evaluateLineReadiness -- tax, discount, credits", () => {
  it("tax needs no category and no item, groups as tax/charge (test 12)", () => {
    const r = evaluateLineReadiness(input({ treatment: "TAX", spendCategoryId: null, lineTotal: 18.42 }));
    expect(r.ready).toBe(true);
    expect(r.group).toBe("tax_charge");
    expect(r.inventoryEffect.kind).toBe("none");
  });

  it("a discount needs a scope; its financial amount is always negative (test 11)", () => {
    expect(evaluateLineReadiness(input({ treatment: "DISCOUNT", spendCategoryId: null, lineTotal: 15 })).ready).toBe(false);
    const r = evaluateLineReadiness(input({ treatment: "DISCOUNT", discountScope: "DOCUMENT", spendCategoryId: null, lineTotal: 15 }));
    expect(r.ready).toBe(true);
    expect(r.group).toBe("credit_adjustment");
    expect(r.financialAmount).toBe(-15);
  });

  it("a credit without a subtype asks the inventory question (test 6/7)", () => {
    const r = evaluateLineReadiness(input({ treatment: "CREDIT_RETURN", spendCategoryId: null, lineTotal: -24 }));
    expect(r.ready).toBe(false);
    expect(r.issues[0]).toMatch(/physically leave the store/i);
  });

  it("a financial credit reduces the total with no inventory impact (test 7)", () => {
    const r = evaluateLineReadiness(input({ treatment: "CREDIT_RETURN", creditSubtype: "FINANCIAL_CREDIT", spendCategoryId: null, lineTotal: 24 }));
    expect(r.ready).toBe(true);
    expect(r.financialAmount).toBe(-24);
    expect(r.inventoryEffect.kind).toBe("none");
    expect(r.group).toBe("credit_adjustment");
  });

  it("a returnable-container credit (CASES RETURNED) creates no inventory movement and is auto-acceptable at high confidence (test 8)", () => {
    const r = evaluateLineReadiness(input({ status: "PENDING_REVIEW", resolutionSource: "VENDOR_TREATMENT_RULE", aiConfidence: 1, treatment: "CREDIT_RETURN", creditSubtype: "RETURNABLE_CONTAINER_CREDIT", spendCategoryId: null, lineTotal: -24 }));
    expect(r.acceptable).toBe(true);
    expect(r.inventoryEffect.kind).toBe("none");
    expect(r.aiLabel).toBe("Matched previous decision");
  });

  it("an inventory return requires item, qty, unit, location, reason and acknowledgment, then decreases inventory (test 9)", () => {
    const partial = evaluateLineReadiness(input({ treatment: "CREDIT_RETURN", creditSubtype: "INVENTORY_RETURN", spendCategoryId: null, lineTotal: -24 }));
    expect(partial.ready).toBe(false);
    expect(partial.issues.length).toBeGreaterThanOrEqual(5);
    const full = evaluateLineReadiness(
      input({
        treatment: "CREDIT_RETURN",
        creditSubtype: "INVENTORY_RETURN",
        spendCategoryId: null,
        lineTotal: -24,
        inventoryItemId: "item-1",
        returnQuantity: 2,
        returnUnitCode: "CASE",
        returnLocationId: "loc-1",
        returnReason: "Damaged",
        returnImpactAcknowledged: true,
        returnBaseQuantity: 20,
        returnBaseUnitCode: "LB",
        returnOnHandQuantity: 50,
      })
    );
    expect(full.ready).toBe(true);
    expect(full.group).toBe("inventory_return");
    expect(full.inventoryEffect).toEqual({ kind: "decrease", quantity: 20, unitCode: "LB" });
  });

  it("an inventory return can never silently go negative (test 10)", () => {
    const r = evaluateLineReadiness(
      input({ treatment: "CREDIT_RETURN", creditSubtype: "INVENTORY_RETURN", spendCategoryId: null, inventoryItemId: "item-1", returnQuantity: 60, returnUnitCode: "LB", returnLocationId: "loc-1", returnReason: "x", returnImpactAcknowledged: true, returnBaseQuantity: 60, returnBaseUnitCode: "LB", returnOnHandQuantity: 50 })
    );
    expect(r.ready).toBe(false);
    expect(r.issues.some((i) => /cannot go negative/i.test(i))).toBe(true);
  });

  it("an inventory return is never auto-accepted, whatever the confidence", () => {
    expect(isAutoAcceptable(input({ status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.99, treatment: "CREDIT_RETURN", creditSubtype: "INVENTORY_RETURN" }), [])).toBe(false);
  });
});

describe("evaluateLineReadiness -- inventory purchases and unresolved", () => {
  it("an unresolved / unclassified line always blocks (tests 15/16)", () => {
    expect(evaluateLineReadiness(input({ status: "UNCLASSIFIED", treatment: "UNRESOLVED" })).status).toBe("needs_classification");
    const r = evaluateLineReadiness(input({ status: "PENDING_REVIEW", treatment: "UNRESOLVED", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.43 }));
    expect(r.classificationSettled).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.group).toBe("needs_attention");
  });

  it("an inventory purchase follows item match then receiving (test 1)", () => {
    const base = input({ treatment: "INVENTORY_PURCHASE", spendCategoryId: null, inventoryItemId: "item-1" });
    expect(evaluateLineReadiness({ ...base, receivingReady: false }).issues[0]).toMatch(/received quantity/i);
    const ready = evaluateLineReadiness({ ...base, receivingReady: true, inventoryIncrease: { quantity: 20, unitCode: "LB" } });
    expect(ready.ready).toBe(true);
    expect(ready.group).toBe("inventory");
    expect(ready.inventoryEffect).toEqual({ kind: "increase", quantity: 20, unitCode: "LB" });
  });

  it("a high-confidence existing-item candidate is settled (accepted on continue) but still needs receiving", () => {
    const r = evaluateLineReadiness(input({ treatment: "INVENTORY_PURCHASE", status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.96, spendCategoryId: null, aiSuggestedInventoryItemId: "item-9", receivingReady: null }));
    expect(r.classificationSettled).toBe(true);
    expect(r.acceptable).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("a new-item proposal is never auto-accepted; a delivery conflict or package mismatch blocks a matched line", () => {
    expect(evaluateLineReadiness(input({ treatment: "INVENTORY_PURCHASE", status: "PENDING_REVIEW", resolutionSource: "AI_SUGGESTED", aiConfidence: 0.99, aiSuggestedInventoryItemId: "pending-item", aiSuggestedIsNewProposal: true })).classificationSettled).toBe(false);
    const base = input({ treatment: "INVENTORY_PURCHASE", spendCategoryId: null, inventoryItemId: "item-1", receivingReady: true });
    expect(evaluateLineReadiness({ ...base, hasDeliveryConflict: true }).ready).toBe(false);
    expect(evaluateLineReadiness({ ...base, hasPackageMismatch: true }).ready).toBe(false);
    expect(evaluateLineReadiness({ ...base, priceRequiresAck: true }).ready).toBe(false);
  });

  it("changing classification recalculates immediately from the same input (test 18)", () => {
    const asExpense = evaluateLineReadiness(input({}));
    const asInventory = evaluateLineReadiness(input({ treatment: "INVENTORY_PURCHASE", status: "PENDING_REVIEW", spendCategoryId: null }));
    expect(asExpense.ready).toBe(true);
    expect(asInventory.ready).toBe(false);
    expect(asInventory.issues[0]).toMatch(/no item match/i);
  });
});

describe("summarizeLineReadiness / postPrimaryLabel (tests 25/26/27/32)", () => {
  it("counts per group, hasInventoryChanges, and the post button label agree", () => {
    const results = [
      evaluateLineReadiness(input({ lineKey: "a" })),
      evaluateLineReadiness(input({ lineKey: "b", treatment: "TAX", spendCategoryId: null })),
      evaluateLineReadiness(input({ lineKey: "c", treatment: "CREDIT_RETURN", creditSubtype: "FINANCIAL_CREDIT", spendCategoryId: null })),
    ];
    const s = summarizeLineReadiness(results);
    expect(s).toMatchObject({ totalLines: 3, readyCount: 3, needsAttentionCount: 0, expenseCount: 1, taxChargeCount: 1, creditAdjustmentCount: 1, inventoryCount: 0, allReady: true, allClassified: true, hasInventoryChanges: false });
    expect(postPrimaryLabel(s.hasInventoryChanges)).toBe("Post invoice");

    const mixed = [...results, evaluateLineReadiness(input({ lineKey: "d", treatment: "INVENTORY_PURCHASE", spendCategoryId: null, inventoryItemId: "i", receivingReady: true, inventoryIncrease: { quantity: 5, unitCode: "LB" } }))];
    const m = summarizeLineReadiness(mixed);
    expect(m.hasInventoryChanges).toBe(true);
    expect(m.inventoryCount).toBe(1);
    expect(postPrimaryLabel(m.hasInventoryChanges)).toBe("Post invoice & inventory");
  });

  it("one unresolved line blocks the whole document; an empty document is never ready", () => {
    const s = summarizeLineReadiness([evaluateLineReadiness(input({ lineKey: "a" })), evaluateLineReadiness(input({ lineKey: "b", status: "UNCLASSIFIED", treatment: "UNRESOLVED" }))]);
    expect(s.allReady).toBe(false);
    expect(s.allClassified).toBe(false);
    expect(s.unresolvedCount).toBe(1);
    expect(summarizeLineReadiness([]).allReady).toBe(false);
  });
});
