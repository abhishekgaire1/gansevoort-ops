import { describe, expect, it } from "vitest";
import { reconcileTotals } from "@/app/lib/purchaseDocuments/totalsReconciliation";

// Test 24: totals reconcile across all line types.
describe("reconcileTotals", () => {
  it("sums merchandise, expenses/fees, tax, discounts and credits into the final total (credits/discounts always negative)", () => {
    const r = reconcileTotals(
      [
        { treatment: "INVENTORY_PURCHASE", lineTotal: 86 },
        { treatment: "INVENTORY_PURCHASE", lineTotal: 55.5 },
        { treatment: "EXPENSE", lineTotal: 425 },
        { treatment: "FREIGHT_FEE", lineTotal: 35 },
        { treatment: "TAX", lineTotal: 18.42 },
        { treatment: "DISCOUNT", lineTotal: 10 },
        { treatment: "CREDIT_RETURN", lineTotal: -24 },
      ],
      { tax: null, fees: null, total: 585.92 }
    );
    expect(r.merchandiseSubtotal).toBe(141.5);
    expect(r.expensesAndFees).toBe(460);
    expect(r.tax).toBe(18.42);
    expect(r.discounts).toBe(-10);
    expect(r.credits).toBe(-24);
    expect(r.computedTotal).toBe(585.92);
    expect(r.reconciles).toBe(true);
    expect(r.usedHeaderTax).toBe(false);
  });

  it("uses the header tax/fees when no TAX / FREIGHT_FEE line exists, and reports the difference otherwise", () => {
    const r = reconcileTotals([{ treatment: "INVENTORY_PURCHASE", lineTotal: 240 }], { tax: 18.42, fees: null, total: 258.42 });
    expect(r.usedHeaderTax).toBe(true);
    expect(r.computedTotal).toBe(258.42);
    expect(r.reconciles).toBe(true);
    const off = reconcileTotals([{ treatment: "INVENTORY_PURCHASE", lineTotal: 240 }], { tax: null, fees: null, total: 258.42 });
    expect(off.reconciles).toBe(false);
    expect(off.difference).toBeCloseTo(-18.42, 2);
  });

  it("keeps unclassified lines visible as their own bucket and never fails on missing amounts", () => {
    const r = reconcileTotals([{ treatment: "UNRESOLVED", lineTotal: -12.5 }, { treatment: "EXPENSE", lineTotal: null }], { tax: null, fees: null, total: null });
    expect(r.unresolved).toBe(-12.5);
    expect(r.reconciles).toBeNull();
    expect(r.difference).toBeNull();
  });
});
