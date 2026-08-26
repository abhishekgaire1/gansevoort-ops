import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: every underlying report/data function is mocked -- this file
// tests toolRegistry.ts's OWN composition (arg validation, org-safety,
// row/date caps, evidence construction), never re-tests the already-
// covered report RPCs themselves.

const { listInventoryBalancesMock } = vi.hoisted(() => ({ listInventoryBalancesMock: vi.fn() }));
vi.mock("@/app/lib/inventory/listInventoryBalances", () => ({ listInventoryBalances: listInventoryBalancesMock }));

const { getPurchasingReportMock } = vi.hoisted(() => ({ getPurchasingReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/purchasingReport", () => ({ getPurchasingReport: getPurchasingReportMock }));

const { getReceivingReportMock } = vi.hoisted(() => ({ getReceivingReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/receivingReport", () => ({ getReceivingReport: getReceivingReportMock }));

const { getUsageReportMock } = vi.hoisted(() => ({ getUsageReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/usageReport", () => ({ getUsageReport: getUsageReportMock }));

const { getWasteReportMock } = vi.hoisted(() => ({ getWasteReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/wasteReport", () => ({ getWasteReport: getWasteReportMock }));

const { listCycleCountSummariesMock } = vi.hoisted(() => ({ listCycleCountSummariesMock: vi.fn() }));
vi.mock("@/app/lib/inventory/cycleCounts", () => ({ listCycleCountSummaries: listCycleCountSummariesMock }));

const { listHighWithdrawalAlertsActionMock } = vi.hoisted(() => ({ listHighWithdrawalAlertsActionMock: vi.fn() }));
vi.mock("@/app/actions/inventoryAlerts", () => ({ listHighWithdrawalAlertsAction: listHighWithdrawalAlertsActionMock }));

const { lookupItemPurchaseCostMock } = vi.hoisted(() => ({ lookupItemPurchaseCostMock: vi.fn() }));
vi.mock("@/app/lib/ai/tasks/chat/itemPurchaseCost", () => ({
  lookupItemPurchaseCost: lookupItemPurchaseCostMock,
  ITEM_COST_LIMITATIONS: ["Reflects the verified purchase line amount only."],
}));

import { validateToolArgs, executeTool, type ChatToolContext } from "@/app/lib/ai/tasks/chat/toolRegistry";

const ORG_ID = "org-1";
const CTX: ChatToolContext = {
  supabase: {} as never,
  organizationId: ORG_ID,
  currentActorAppUserId: "app-user-1",
  timeZone: "America/New_York",
  now: new Date("2026-08-19T18:00:00Z"),
};

beforeEach(() => {
  listInventoryBalancesMock.mockReset();
  getPurchasingReportMock.mockReset();
  getReceivingReportMock.mockReset();
  getUsageReportMock.mockReset();
  getWasteReportMock.mockReset();
  listCycleCountSummariesMock.mockReset();
  listHighWithdrawalAlertsActionMock.mockReset();
  lookupItemPurchaseCostMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateToolArgs -- strict schemas reject anything outside the allowlisted shape", () => {
  it("accepts a valid, minimal args object for every tool", () => {
    expect(validateToolArgs("get_inventory_status", {})).toEqual({ ok: true, args: {} });
    expect(validateToolArgs("get_purchasing_summary", { period: "7D" })).toEqual({ ok: true, args: { period: "7D" } });
  });

  it("rejects an attempt to smuggle an organizationId into tool args (the model can never override organization scope)", () => {
    const result = validateToolArgs("get_inventory_status", { organizationId: "org-attacker" });
    expect(result.ok).toBe(false);
  });

  it("rejects an attempt to smuggle raw SQL into tool args", () => {
    const result = validateToolArgs("get_inventory_status", { sql: "DELETE FROM inventory_movements" });
    expect(result.ok).toBe(false);
  });

  it("rejects a period value outside the allowed TODAY/7D/30D enum", () => {
    const result = validateToolArgs("get_usage_summary", { period: "365D" });
    expect(result.ok).toBe(false);
  });

  it("rejects a cycle-count limit above the 10-row cap", () => {
    const result = validateToolArgs("get_cycle_count_summary", { limit: 500 });
    expect(result.ok).toBe(false);
  });
});

describe("get_inventory_status", () => {
  const BALANCES = [
    { inventoryItemId: "i1", itemName: "Chicken Breast", locationId: "l1", locationName: "Walk-in Cooler", baseUnitCode: "LB", balance: 2, fullReferenceQuantity: 100, referenceSource: "RESTOCK" as const, referenceSetAt: null, includesLegacyEstimate: false },
    { inventoryItemId: "i2", itemName: "Romaine Lettuce", locationId: "l1", locationName: "Walk-in Cooler", baseUnitCode: "CASE", balance: 40, fullReferenceQuantity: 50, referenceSource: "RESTOCK" as const, referenceSetAt: null, includesLegacyEstimate: false },
  ];

  it("reuses listInventoryBalances (the same authoritative balance calculation Current Inventory uses) rather than recomputing anything", async () => {
    listInventoryBalancesMock.mockResolvedValue(BALANCES);
    const result = await executeTool("get_inventory_status", CTX, {});
    expect(listInventoryBalancesMock).toHaveBeenCalledWith(CTX.supabase, ORG_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Chicken Breast");
      expect(result.evidence[0]).toMatchObject({ sourceType: "inventory_status", href: "/manager/reports/inventory-status" });
    }
  });

  it("filters to a specific item by name (organization-safe substring match over already-org-scoped balances)", async () => {
    listInventoryBalancesMock.mockResolvedValue(BALANCES);
    const result = await executeTool("get_inventory_status", CTX, { itemNameContains: "chicken" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Chicken Breast");
      expect(result.dataText).not.toContain("Romaine");
    }
  });

  it("onlyAttention filters out healthy/full stock", async () => {
    listInventoryBalancesMock.mockResolvedValue(BALANCES);
    const result = await executeTool("get_inventory_status", CTX, { onlyAttention: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Chicken Breast"); // low stock (2/100)
      expect(result.dataText).not.toContain("Romaine"); // healthy stock (40/50)
    }
  });

  it("returns insufficientData when nothing matches", async () => {
    listInventoryBalancesMock.mockResolvedValue(BALANCES);
    const result = await executeTool("get_inventory_status", CTX, { itemNameContains: "nonexistent-item-xyz" });
    expect(result).toMatchObject({ ok: true, insufficientData: true, evidence: [] });
  });

  it("caps returned rows at 50", async () => {
    const manyRows = Array.from({ length: 80 }, (_, i) => ({ ...BALANCES[0], inventoryItemId: `i${i}`, itemName: `Item ${i}` }));
    listInventoryBalancesMock.mockResolvedValue(manyRows);
    const result = await executeTool("get_inventory_status", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lineCount = result.dataText.split("\n").filter((l) => l.startsWith("- ")).length;
      expect(lineCount).toBeLessThanOrEqual(50);
    }
  });
});

describe("get_purchasing_summary", () => {
  it("reuses getPurchasingReport with the trusted organizationId and a resolved (never model-supplied) date range", async () => {
    getPurchasingReportMock.mockResolvedValue({ totalPurchaseValue: 1234.5, documentCount: 3, vendorCount: 2, itemCount: 5, byVendor: [{ id: "v1", name: "Acme Foods", totalValue: 900 }], byCategory: [] });
    const result = await executeTool("get_purchasing_summary", CTX, { period: "7D" });
    expect(getPurchasingReportMock).toHaveBeenCalledWith(CTX.supabase, ORG_ID, expect.any(String), expect.any(String));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Acme Foods");
      expect(result.period?.key).toBe("7D");
      expect(result.evidence[0]).toMatchObject({ sourceType: "purchasing_report", href: "/manager/reports/purchasing" });
    }
  });

  it("reports insufficientData when there is no purchasing activity", async () => {
    getPurchasingReportMock.mockResolvedValue({ totalPurchaseValue: 0, documentCount: 0, vendorCount: 0, itemCount: 0, byVendor: [], byCategory: [] });
    const result = await executeTool("get_purchasing_summary", CTX, {});
    expect(result).toMatchObject({ ok: true, insufficientData: true, evidence: [] });
  });
});

describe("get_receiving_summary / get_usage_summary / get_waste_summary -- correct report-function reuse and evidence routing", () => {
  it("get_receiving_summary", async () => {
    getReceivingReportMock.mockResolvedValue({ documentCount: 2, byStatus: [{ status: "POSTED", count: 2 }], byVendor: [], creditLineCount: 0, readyToPostCount: 0, partiallyPostedCount: 0, postedCount: 2 });
    const result = await executeTool("get_receiving_summary", CTX, {});
    expect(getReceivingReportMock).toHaveBeenCalledWith(CTX.supabase, ORG_ID, expect.any(String), expect.any(String));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence[0]).toMatchObject({ sourceType: "receiving_report", href: "/manager/reports/receiving" });
  });

  it("get_usage_summary", async () => {
    getUsageReportMock.mockResolvedValue({ movementCount: 4, byItem: [{ itemId: "i1", itemName: "Chicken", baseUnitCode: "LB", quantity: 12 }], byStation: [{ stationId: "s1", stationName: "Grill", movementCount: 4 }] });
    const result = await executeTool("get_usage_summary", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Grill");
      expect(result.evidence[0]).toMatchObject({ sourceType: "usage_report", href: "/manager/reports/usage" });
    }
  });

  it("get_waste_summary never describes station waste as implemented", async () => {
    getWasteReportMock.mockResolvedValue({ eventCount: 1, byItem: [{ itemId: "i1", itemName: "Milk", unitCode: "GAL", quantity: 1 }], byReason: [{ reasonCode: "SPOILED", eventCount: 1 }] });
    const result = await executeTool("get_waste_summary", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("storage waste only");
      expect(result.evidence[0]).toMatchObject({ sourceType: "waste_report" });
    }
  });
});

describe("get_cycle_count_summary", () => {
  it("reuses listCycleCountSummaries with the trusted organization/actor context and builds cycle-count-detail evidence", async () => {
    listCycleCountSummariesMock.mockResolvedValue([
      { cycleCountId: "cc-1", locationId: "l1", locationName: "Walk-in Cooler", status: "COMPLETED", version: 3, startedByAppUserId: "u1", startedByName: "Jordan", startedAt: "2026-08-18T10:00:00Z", completedByAppUserId: "u1", completedByName: "Jordan", completedAt: "2026-08-18T11:00:00Z", completionNote: "ok", cancelledByAppUserId: null, cancelledByName: null, cancelledAt: null, cancellationReason: null, countedItemCount: 10, varianceItemCount: 2, isOwnedByCurrentManager: true },
    ]);
    const result = await executeTool("get_cycle_count_summary", CTX, {});
    expect(listCycleCountSummariesMock).toHaveBeenCalledWith(CTX.supabase, expect.objectContaining({ organizationId: ORG_ID, currentActorAppUserId: "app-user-1" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Walk-in Cooler");
      expect(result.evidence[0]).toMatchObject({ sourceType: "cycle_count", sourceId: "cc-1", href: "/manager/inventory/cycle-count/cc-1" });
    }
  });

  it("never mentions second-manager approval terminology", async () => {
    listCycleCountSummariesMock.mockResolvedValue([]);
    const result = await executeTool("get_cycle_count_summary", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dataText.toLowerCase()).not.toContain("approv");
  });
});

describe("get_inventory_alerts", () => {
  it("reuses listHighWithdrawalAlertsAction (already org-scoped + enriched) and marks alerts as informational, not an approval", async () => {
    listHighWithdrawalAlertsActionMock.mockResolvedValue({
      ok: true,
      alerts: [
        { exceptionId: "exc-1", occurredAt: "2026-08-19T12:00:00Z", itemId: "i1", itemName: "Chicken", stationId: "s1", stationName: "Grill", employeeName: "Jordan", sourceLocationId: "l1", sourceLocationName: "Walk-in Cooler", observedQuantity: 40, thresholdQuantity: 20, unitCode: "LB", status: "open" },
      ],
    });
    const result = await executeTool("get_inventory_alerts", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("informational");
      expect(result.evidence[0]).toMatchObject({ sourceType: "inventory_alert", sourceId: "exc-1", href: "/manager/inventory/alerts/exc-1" });
    }
  });

  it("surfaces an action-layer auth/load failure as a tool failure, never a crash", async () => {
    listHighWithdrawalAlertsActionMock.mockResolvedValue({ ok: false, reason: "load_failed", message: "Something went wrong. Try again." });
    const result = await executeTool("get_inventory_alerts", CTX, {});
    expect(result).toEqual({ ok: false, message: "Could not load Inventory Alerts." });
  });
});

describe("get_reports_overview", () => {
  it("composes the same authoritative report functions the Overview page uses, never a separate computation", async () => {
    getPurchasingReportMock.mockResolvedValue({ totalPurchaseValue: 500, documentCount: 1, vendorCount: 1, itemCount: 1, byVendor: [], byCategory: [] });
    getReceivingReportMock.mockResolvedValue({ documentCount: 1, byStatus: [], byVendor: [], creditLineCount: 0, readyToPostCount: 1, partiallyPostedCount: 0, postedCount: 0 });
    getUsageReportMock.mockResolvedValue({ movementCount: 2, byItem: [], byStation: [] });
    getWasteReportMock.mockResolvedValue({ eventCount: 0, byItem: [], byReason: [] });
    listInventoryBalancesMock.mockResolvedValue([{ inventoryItemId: "i1", itemName: "X", locationId: "l1", locationName: "L", baseUnitCode: "LB", balance: 1, fullReferenceQuantity: 50, referenceSource: null, referenceSetAt: null, includesLegacyEstimate: false }]);

    const result = await executeTool("get_reports_overview", CTX, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("Purchasing");
      expect(result.dataText).toContain("low stock");
      expect(result.evidence[0]).toMatchObject({ sourceType: "reports_overview", href: "/manager/reports" });
    }
  });
});

describe("get_item_purchase_cost", () => {
  it("rejects args outside the strict schema (e.g. a smuggled itemId)", () => {
    const result = validateToolArgs("get_item_purchase_cost", { itemId: "attacker-item" });
    expect(result.ok).toBe(false);
  });

  it("not_found -> insufficientData true, no evidence, never invents a cost", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({ status: "not_found" });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Frozen Shrimp" });
    expect(result).toMatchObject({ ok: true, insufficientData: true, evidence: [] });
    if (result.ok) expect(result.dataText).toContain("No inventory item matching");
  });

  it("11. ambiguous -> reaches synthesis (insufficientData false) so the model can ask which item, lists candidates, no evidence yet", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({ status: "ambiguous", candidateNames: ["Whole Milk Quart", "Whole Milk Half Gallon"] });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insufficientData).toBe(false);
      expect(result.evidence).toEqual([]);
      expect(result.dataText).toContain("Whole Milk Quart");
      expect(result.dataText).toContain("Whole Milk Half Gallon");
      expect(result.dataText.toLowerCase()).toContain("do not guess");
    }
  });

  it("12. item exists but no verified cost -> reaches synthesis, cites item_detail evidence, never falls back to an unrelated total", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({ status: "no_verified_cost", item: { id: "item-1", name: "Whole Milk Quart", baseUnitCode: "PIECE" } });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk Quart" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insufficientData).toBe(false);
      expect(result.dataText).toContain("Whole Milk Quart exists in inventory");
      expect(result.dataText).toContain("no verified/posted purchase cost");
      expect(result.evidence).toEqual([expect.objectContaining({ sourceType: "item_detail", sourceId: "item-1", href: "/manager/inventory/items/item-1" })]);
    }
  });

  it("23. exact result cites both item and vendor-filtered purchasing-report evidence, and includes the latest + weighted-average figures", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({
      status: "exact",
      item: { id: "item-1", name: "Whole Milk Quart", baseUnitCode: "PIECE" },
      latest: {
        vendorId: "vendor-1",
        vendorName: "Acme Dairy",
        documentId: "doc-1",
        documentNumber: "INV-100",
        documentDate: "2026-08-15",
        packageQuantity: 1,
        packageUnit: "CASE",
        lineTotal: 48,
        baseQuantity: 12,
        baseUnitCode: "PIECE",
        unitCostPerBaseUnit: 4,
        unitCostPerPackage: 48,
      },
      weightedAverage: {
        windowDays: 30,
        startDate: "2026-07-20",
        endDate: "2026-08-19",
        totalEligibleLineAmount: 96,
        totalEligibleBaseQuantity: 24,
        weightedAverageBaseUnitCost: 4,
        recordCount: 2,
      },
      weightedAverageComplete: true,
      weightedAverageTruncated: false,
      excludedPartialCount: 0,
      excludedUnverifiableMeasurementCount: 0,
      vendorSetTruncated: false,
      revisionSafetyVerified: true,
      limitations: ["Reflects the verified purchase line amount only."],
    });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk Quart" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insufficientData).toBe(false);
      expect(result.dataText).toContain("Acme Dairy");
      expect(result.dataText).toContain("$4.00 per PIECE");
      expect(result.dataText).toContain("weighted-average");
      expect(result.evidence).toEqual([
        expect.objectContaining({ sourceType: "purchase_document", sourceId: "doc-1", href: "/manager/purchases/doc-1" }),
        expect.objectContaining({ sourceType: "purchasing_report", sourceId: "vendor-1", href: "/manager/reports/purchasing?vendor=vendor-1" }),
        expect.objectContaining({ sourceType: "item_detail", sourceId: "item-1" }),
      ]);
    }
  });

  it("reports a truncated weighted average plainly rather than an estimated/partial number", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({
      status: "exact",
      item: { id: "item-1", name: "Whole Milk Quart", baseUnitCode: "PIECE" },
      latest: {
        vendorId: "vendor-1",
        vendorName: "Acme Dairy",
        documentId: "doc-1",
        documentNumber: "INV-100",
        documentDate: "2026-08-15",
        packageQuantity: 1,
        packageUnit: "CASE",
        lineTotal: 48,
        baseQuantity: 12,
        baseUnitCode: "PIECE",
        unitCostPerBaseUnit: 4,
        unitCostPerPackage: 48,
      },
      weightedAverage: null,
      weightedAverageComplete: false,
      weightedAverageTruncated: true,
      excludedPartialCount: 0,
      excludedUnverifiableMeasurementCount: 0,
      vendorSetTruncated: false,
      revisionSafetyVerified: true,
      limitations: ["The weighted average for this window could not be proven complete from available data and is not reported."],
    });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk Quart" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).toContain("could NOT be calculated completely");
      expect(result.dataText).not.toMatch(/weighted-average cost.*\$/); // no number presented as THE average
    }
  });

  it("19. evidence's purchase_document sourceId exactly matches the calculated purchase's documentId", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({
      status: "exact",
      item: { id: "item-1", name: "Whole Milk Quart", baseUnitCode: "PIECE" },
      latest: {
        vendorId: "vendor-1",
        vendorName: "Acme Dairy",
        documentId: "doc-precise-1",
        documentNumber: "INV-77",
        documentDate: "2026-08-15",
        packageQuantity: 10,
        packageUnit: "CASE",
        lineTotal: 500,
        baseQuantity: 120,
        baseUnitCode: "PIECE",
        unitCostPerBaseUnit: 500 / 120,
        unitCostPerPackage: 50,
      },
      weightedAverage: null,
      weightedAverageComplete: false,
      weightedAverageTruncated: false,
      excludedPartialCount: 0,
      excludedUnverifiableMeasurementCount: 0,
      vendorSetTruncated: false,
      revisionSafetyVerified: true,
      limitations: [],
    });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk Quart" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const purchaseDocEvidence = result.evidence.find((e) => e.sourceType === "purchase_document");
      expect(purchaseDocEvidence?.sourceId).toBe("doc-precise-1");
      expect(result.dataText).toContain("INV-77");
      expect(result.dataText).toContain("500.00");
    }
  });

  it("neither a latest price nor a weighted average is ever stated in prose when the vendor set is truncated ('incomplete' status)", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({
      status: "incomplete",
      item: { id: "item-1", name: "Whole Milk Quart", baseUnitCode: "PIECE" },
      reason: "This item has verified purchases from more than 20 vendors -- the overall latest purchase and weighted average cannot be safely determined in this pass.",
    });
    const result = await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "Whole Milk Quart" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataText).not.toMatch(/\$\d/); // no dollar figure anywhere in the text
      expect(result.dataText).toContain("more than 20 vendors");
      expect(result.dataText).toContain("Do not state a latest price");
    }
  });

  it("passes the resolved windowDays through to the lookup, defaulting to 30", async () => {
    lookupItemPurchaseCostMock.mockResolvedValue({ status: "not_found" });
    await executeTool("get_item_purchase_cost", CTX, { itemNameQuery: "X" });
    expect(lookupItemPurchaseCostMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_ID }), "X", 30);
  });
});
