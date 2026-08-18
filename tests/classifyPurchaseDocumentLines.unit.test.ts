import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database -- every collaborator (Postgres reads,
// the claim RPC, deterministic matching, the AI provider) is mocked. Proves
// the orchestrator's own control flow: claim-before-work, deterministic
// tier first with zero AI calls when it fully resolves, AI only for
// leftovers, and SUCCEEDED/FAILED reported via finish in a try/finally.

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { getLinesNeedingClassificationMock } = vi.hoisted(() => ({ getLinesNeedingClassificationMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/getLinesNeedingClassification", () => ({ getLinesNeedingClassification: getLinesNeedingClassificationMock }));

const { tryClaimMock, finishClaimMock } = vi.hoisted(() => ({ tryClaimMock: vi.fn(), finishClaimMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/classificationRunClaimRpc", () => ({
  tryClaimClassificationRunRpc: tryClaimMock,
  finishClassificationRunRpc: finishClaimMock,
}));

const { resolveDeterministicMock } = vi.hoisted(() => ({ resolveDeterministicMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/resolveDeterministicClassification", () => ({ resolveDeterministicClassification: resolveDeterministicMock }));

const { buildShortlistMock } = vi.hoisted(() => ({ buildShortlistMock: vi.fn() }));
vi.mock("@/app/lib/itemMaster/buildItemShortlist", () => ({ buildItemShortlist: buildShortlistMock }));

const { runItemClassificationMock } = vi.hoisted(() => ({ runItemClassificationMock: vi.fn() }));
vi.mock("@/app/lib/ai/tasks/itemClassification/runItemClassification", () => ({ runItemClassification: runItemClassificationMock }));

vi.mock("@/app/lib/ai/providers/gemini", () => ({
  GeminiProvider: class {},
}));

const { resolveDeterministicRpcMock, recordAiSuggestedCandidateRpcMock, recordAiItemProposalRpcMock } = vi.hoisted(() => ({
  resolveDeterministicRpcMock: vi.fn(),
  recordAiSuggestedCandidateRpcMock: vi.fn(),
  recordAiItemProposalRpcMock: vi.fn(),
}));
vi.mock("@/app/lib/itemMaster/resolveLineClassificationDeterministicRpc", () => ({ resolveLineClassificationDeterministicRpc: resolveDeterministicRpcMock }));
vi.mock("@/app/lib/itemMaster/recordAiSuggestedCandidateRpc", () => ({ recordAiSuggestedCandidateRpc: recordAiSuggestedCandidateRpcMock }));
vi.mock("@/app/lib/itemMaster/recordAiItemProposalRpc", () => ({ recordAiItemProposalRpc: recordAiItemProposalRpcMock }));

import { classifyPurchaseDocumentLines } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";

const LINE_A = { lineKey: "line-a", vendorSku: "SKU-A", description: "Chicken Thigh", packageUnit: "CS", measuredUnit: "LB" };
const LINE_B = { lineKey: "line-b", vendorSku: "SKU-B", description: "Napkins", packageUnit: "CS", measuredUnit: "EA" };

function fakeSupabase() {
  const single = vi.fn().mockResolvedValue({ data: { vendor_id: "vendor-1" }, error: null });
  const eqPdOrg = vi.fn().mockReturnValue({ single });
  const eqPdId = vi.fn().mockReturnValue({ eq: eqPdOrg });
  const selectPd = vi.fn().mockReturnValue({ eq: eqPdId });

  const unitsChain = { order: vi.fn().mockResolvedValue({ data: [{ code: "LB", name: "Pound" }, { code: "EA", name: "Each" }, { code: "CS", name: "Case" }], error: null }) };
  const selectUnits = vi.fn().mockReturnValue(unitsChain);

  // buildClassificationCandidateContext's org-scoped, active-only category
  // reads -- each .eq() call returns a thenable-shaped chain ending in the
  // resolved rows, mirroring the real supabase-js query builder shape.
  const categoryChain = { order: vi.fn().mockResolvedValue({ data: [{ id: "cat-1", name: "Produce" }], error: null }) };
  const eqCategoryActive = vi.fn().mockReturnValue(categoryChain);
  const eqCategoryOrg = vi.fn().mockReturnValue({ eq: eqCategoryActive });
  const selectCategories = vi.fn().mockReturnValue({ eq: eqCategoryOrg });

  const spendChain = { order: vi.fn().mockResolvedValue({ data: [{ id: "spend-1", name: "Food & Beverage", parent_id: null }], error: null }) };
  const eqSpendActive = vi.fn().mockReturnValue(spendChain);
  const eqSpendOrg = vi.fn().mockReturnValue({ eq: eqSpendActive });
  const selectSpendCategories = vi.fn().mockReturnValue({ eq: eqSpendOrg });

  const from = vi.fn((table: string) => {
    if (table === "purchase_documents") return { select: selectPd };
    if (table === "units") return { select: selectUnits };
    if (table === "inventory_categories") return { select: selectCategories };
    if (table === "spend_categories") return { select: selectSpendCategories };
    throw new Error(`unexpected table: ${table}`);
  });

  return { from };
}

beforeEach(() => {
  getServiceRoleClientMock.mockReset().mockReturnValue(fakeSupabase());
  getLinesNeedingClassificationMock.mockReset();
  tryClaimMock.mockReset();
  finishClaimMock.mockReset().mockResolvedValue(undefined);
  resolveDeterministicMock.mockReset();
  buildShortlistMock.mockReset().mockResolvedValue([]);
  runItemClassificationMock.mockReset();
  resolveDeterministicRpcMock.mockReset().mockResolvedValue(undefined);
  recordAiSuggestedCandidateRpcMock.mockReset().mockResolvedValue(undefined);
  recordAiItemProposalRpcMock.mockReset().mockResolvedValue({ inventoryItemId: "new-item-1" });
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("classifyPurchaseDocumentLines", () => {
  it("is a no-op and never attempts a claim when no lines need classification", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([]);
    await classifyPurchaseDocumentLines("pd-1", "org-1");
    expect(tryClaimMock).not.toHaveBeenCalled();
  });

  it("forwards includeUnconfirmedAiProposals through to getLinesNeedingClassification unchanged", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([]);
    await classifyPurchaseDocumentLines("pd-1", "org-1", { includeUnconfirmedAiProposals: true });
    expect(getLinesNeedingClassificationMock).toHaveBeenCalledWith(expect.anything(), "pd-1", "org-1", { includeUnconfirmedAiProposals: true });
  });

  it("is a no-op when the claim is ALREADY_RUNNING", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A]);
    tryClaimMock.mockResolvedValue({ claimId: null, status: "ALREADY_RUNNING" });
    await classifyPurchaseDocumentLines("pd-1", "org-1");
    expect(resolveDeterministicMock).not.toHaveBeenCalled();
    expect(finishClaimMock).not.toHaveBeenCalled();
  });

  it("resolves a deterministic match with zero AI calls and finishes SUCCEEDED", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue({ inventoryItemId: "item-1", resolutionSource: "VENDOR_SKU_MAPPING" });

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(resolveDeterministicRpcMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-a",
      inventoryItemId: "item-1",
      resolutionSource: "VENDOR_SKU_MAPPING",
    });
    expect(runItemClassificationMock).not.toHaveBeenCalled();
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
  });

  it("sends only the deterministically-unresolved lines to AI, and records both a candidate match and a new-item proposal", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A, LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockImplementation(async (_supabase, input: { vendorSku: string | null }) =>
      input.vendorSku === "SKU-A" ? { inventoryItemId: "item-1", resolutionSource: "VENDOR_SKU_MAPPING" } : null
    );
    runItemClassificationMock.mockResolvedValue({
      lines: [
        { lineKey: "line-b", candidateItemId: null, proposedName: "Napkins", proposedDisposition: "NON_INVENTORY", proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: 0.4, reasoning: null },
      ],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    // Only line-b (the deterministically-unresolved one) is sent to AI.
    expect(buildShortlistMock).toHaveBeenCalledTimes(1);
    expect(buildShortlistMock).toHaveBeenCalledWith(expect.anything(), "org-1", "Napkins");
    expect(runItemClassificationMock).toHaveBeenCalledWith(
      expect.anything(),
      { inventoryCategories: [{ id: "cat-1", name: "Produce" }], spendCategories: [{ id: "spend-1", path: "Food & Beverage" }], units: [{ code: "LB", name: "Pound" }, { code: "EA", name: "Each" }, { code: "CS", name: "Case" }] },
      [expect.objectContaining({ lineKey: "line-b" })],
      expect.any(Set)
    );

    expect(recordAiItemProposalRpcMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-b",
      proposedName: "Napkins",
      proposedDisposition: "NON_INVENTORY",
      proposedCategoryId: null,
      proposedSpendCategoryId: null,
      proposedBaseUnitCode: null,
      aiConfidence: 0.4,
    });
    expect(recordAiSuggestedCandidateRpcMock).not.toHaveBeenCalled();
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
  });

  it("records an AI-suggested existing-item candidate", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    runItemClassificationMock.mockResolvedValue({
      lines: [
        { lineKey: "line-b", candidateItemId: "existing-item-1", proposedName: null, proposedDisposition: null, proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: 0.85, reasoning: null },
      ],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(recordAiSuggestedCandidateRpcMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-b",
      candidateInventoryItemId: "existing-item-1",
      aiConfidence: 0.85,
    });
    expect(recordAiItemProposalRpcMock).not.toHaveBeenCalled();
  });

  it("carries a full canonical-id-resolved new-item proposal (the Queso Fresco shape: distinct CASE purchase unit over an LB base unit) through to recordAiItemProposalRpc unchanged", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    runItemClassificationMock.mockResolvedValue({
      lines: [
        {
          lineKey: "line-b",
          candidateItemId: null,
          proposedName: "Queso Fresco Cheese Wheel",
          proposedDisposition: "INVENTORY",
          proposedCategoryId: "cat-dairy",
          proposedSpendCategoryId: "spend-dairy",
          proposedBaseUnitCode: "LB",
          proposedVendorPurchaseUnitCode: "CASE",
          proposedReceivingBehavior: "MEASURE_EACH_DELIVERY",
          proposedFixedConversionFactor: null,
          confidence: 0.88,
          reasoning: "1 CS with an explicit variable total weight (T/WT) -- weighed each delivery.",
        },
      ],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(recordAiItemProposalRpcMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-b",
      proposedName: "Queso Fresco Cheese Wheel",
      proposedDisposition: "INVENTORY",
      proposedCategoryId: "cat-dairy",
      proposedSpendCategoryId: "spend-dairy",
      proposedBaseUnitCode: "LB",
      aiConfidence: 0.88,
      proposedVendorPurchaseUnitCode: "CASE",
      proposedReceivingBehavior: "MEASURE_EACH_DELIVERY",
      proposedFixedConversionFactor: null,
    });
  });

  it("finishes FAILED and rethrows when the AI call throws", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    runItemClassificationMock.mockRejectedValue(new Error("provider unavailable"));

    await expect(classifyPurchaseDocumentLines("pd-1", "org-1")).rejects.toThrow("provider unavailable");
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "FAILED" });
  });

  it("leaves a line with neither a candidate nor a usable proposal unwritten so the next run picks it back up", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    runItemClassificationMock.mockResolvedValue({
      lines: [{ lineKey: "line-b", candidateItemId: null, proposedName: null, proposedDisposition: null, proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: null, reasoning: null }],
      issues: [{ lineKey: "line-b", code: "NO_USABLE_RESULT", message: "AI returned nothing actionable" }],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(recordAiSuggestedCandidateRpcMock).not.toHaveBeenCalled();
    expect(recordAiItemProposalRpcMock).not.toHaveBeenCalled();
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
  });
});
