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

// AI Configuration + Usage/Cost Tracking milestone: classifyRemainingWithAI
// now resolves config and executes through the central router -- neither
// concern belongs to this orchestrator-focused test file (see
// resolveAIConfig.unit.test.ts / executeAITask.unit.test.ts for those), so
// both are replaced with a direct passthrough that never touches a real
// provider or the database.
vi.mock("@/app/lib/ai/router/resolveAIConfig", () => ({
  resolveAIConfig: vi.fn(async () => ({ provider: "gemini", model: "gemini-3.6-flash", source: "application_default" })),
}));
const { executeAITaskMock } = vi.hoisted(() => ({
  executeAITaskMock: vi.fn(async (params: { provider: string; model: string; run: (provider: unknown, model: string) => Promise<{ data: unknown }> }) => {
    const result = await params.run({ name: params.provider }, params.model);
    return result.data;
  }),
}));
vi.mock("@/app/lib/ai/router/executeAITask", () => ({ executeAITask: executeAITaskMock, AIProviderUnavailableError: class extends Error {} }));

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
      expect.any(Set),
      "gemini-3.6-flash"
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

  it("deterministic matching for one line already persisted before an AI provider outage affecting a different, deterministically-unresolved line -- that work is never rolled back or discarded by the later failure", async () => {
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A, LINE_B]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockImplementation(async (_supabase, input: { vendorSku: string | null }) =>
      input.vendorSku === "SKU-A" ? { inventoryItemId: "item-1", resolutionSource: "VENDOR_SKU_MAPPING" } : null
    );
    runItemClassificationMock.mockRejectedValue(new Error("provider unavailable"));

    await expect(classifyPurchaseDocumentLines("pd-1", "org-1")).rejects.toThrow("provider unavailable");

    // LINE_A's deterministic write already happened (its own independent
    // RPC call, already committed) before the shared AI call for LINE_B
    // ever ran -- a later provider outage for the AI-only subset can never
    // undo it.
    expect(resolveDeterministicRpcMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lineKey: "line-a" }));
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "FAILED" });
  });

  // ============================================================
  // Item Matching Robustness fix -- per-line isolation.
  //
  // Reproduced against a real invoice (Capital Paper Inc #178606): the
  // per-result-line write loop had no per-iteration isolation, so a single
  // line's RPC write failing (confirmed root cause: two DIFFERENT lines --
  // a normal purchase and a separate credit/return of the same physical
  // product -- both AI-proposed as the identical brand-new item name,
  // "Black Dome Lid for Hot Cup"; the second write hit
  // inventory_items_org_lower_name_key) aborted the entire batch, discarding
  // every other line's already-successful result and marking the whole run
  // FAILED even though the AI call itself succeeded. These tests prove the
  // orchestrator no longer does that, as defense-in-depth alongside the
  // dedicated SQL-level fix (20260811100079_ai_item_proposal_cross_line_
  // name_collision.sql) that makes record_ai_item_proposal itself reuse
  // the sibling's item instead of raising.
  // ============================================================

  it("Capital Paper regression: a normal purchase line and a credit line for the same product both propose the same new-item name -- one line's write failing does not abort the other's, and the run still finishes SUCCEEDED", async () => {
    const purchaseLine = { lineKey: "line-13", vendorSku: "DDLBSW", description: "SW---- BLACK DOME LID HOT CU", packageUnit: "CS", measuredUnit: "EA" };
    const creditLine = { lineKey: "line-62", vendorSku: "DDLBCR", description: "CREDIT ------ BLACK DOME LID HO", packageUnit: "CS", measuredUnit: "EA" };
    getLinesNeedingClassificationMock.mockResolvedValue([purchaseLine, creditLine]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    runItemClassificationMock.mockResolvedValue({
      lines: [
        { lineKey: "line-13", candidateItemId: null, proposedName: "Black Dome Lid for Hot Cup", proposedDisposition: "INVENTORY", proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: "EA", confidence: 0.9, reasoning: null },
        { lineKey: "line-62", candidateItemId: null, proposedName: "Black Dome Lid for Hot Cup", proposedDisposition: "INVENTORY", proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: "EA", confidence: 0.9, reasoning: null },
      ],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });
    // line-13 (processed first in the AI's own response order) succeeds and
    // creates the new PENDING_REVIEW item; line-62's identical proposal
    // hits the exact raw Postgres error captured from the real 4th
    // diagnostic run against the actual document.
    recordAiItemProposalRpcMock
      .mockResolvedValueOnce({ inventoryItemId: "new-item-black-dome-lid" })
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "inventory_items_org_lower_name_key"'));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(recordAiItemProposalRpcMock).toHaveBeenCalledTimes(2);
    expect(recordAiItemProposalRpcMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ lineKey: "line-13", proposedName: "Black Dome Lid for Hot Cup" }));
    expect(recordAiItemProposalRpcMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ lineKey: "line-62", proposedName: "Black Dome Lid for Hot Cup" }));
    // The whole run still finishes SUCCEEDED -- never FAILED just because
    // one of the two lines hit a write error.
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[item-classification] failed to record AI result for one line",
      expect.objectContaining({ lineKey: "line-62" })
    );
    consoleErrorSpy.mockRestore();
  });

  it("one line's deterministic-tier write failing does not prevent a later line's deterministic write, and the run still finishes SUCCEEDED", async () => {
    const lineC = { lineKey: "line-c", vendorSku: "SKU-C", description: "Paper Towels", packageUnit: "CS", measuredUnit: "EA" };
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A, lineC]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue({ inventoryItemId: "item-1", resolutionSource: "VENDOR_SKU_MAPPING" });
    resolveDeterministicRpcMock.mockRejectedValueOnce(new Error("transient RPC error")).mockResolvedValueOnce(undefined);
    // LINE_A's write throws, so it falls through to the AI tier as a
    // fallback (this test's own point is that lineC's write still
    // succeeds regardless -- what the AI does with LINE_A afterward is
    // covered by the other AI-tier tests).
    runItemClassificationMock.mockResolvedValue({
      lines: [{ lineKey: "line-a", candidateItemId: null, proposedName: null, proposedDisposition: null, proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: null, reasoning: null }],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(resolveDeterministicRpcMock).toHaveBeenCalledTimes(2);
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[item-classification] deterministic resolution failed for one line",
      expect.objectContaining({ lineKey: "line-a" })
    );
    consoleErrorSpy.mockRestore();
  });

  it("a VerifiedLockedError (document moved out of DRAFT/READY_FOR_VERIFICATION mid-run) is a genuine whole-run failure -- it is NOT isolated, stops the loop, and finishes FAILED", async () => {
    const { VerifiedLockedError } = await import("@/app/lib/purchaseDocuments/errors");
    const lineC = { lineKey: "line-c", vendorSku: "SKU-C", description: "Paper Towels", packageUnit: "CS", measuredUnit: "EA" };
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_A, lineC]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue({ inventoryItemId: "item-1", resolutionSource: "VENDOR_SKU_MAPPING" });
    resolveDeterministicRpcMock.mockRejectedValueOnce(new VerifiedLockedError("purchase_document is VERIFIED"));

    await expect(classifyPurchaseDocumentLines("pd-1", "org-1")).rejects.toThrow("purchase_document is VERIFIED");

    // The second line is never reached -- every remaining write would fail
    // identically once the document itself is no longer writable.
    expect(resolveDeterministicRpcMock).toHaveBeenCalledTimes(1);
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "FAILED" });
  });

  it("one line's shortlist lookup failing does not block the shared AI call -- that line is sent through with an empty shortlist", async () => {
    const lineC = { lineKey: "line-c", vendorSku: "SKU-C", description: "Paper Towels", packageUnit: "CS", measuredUnit: "EA" };
    getLinesNeedingClassificationMock.mockResolvedValue([LINE_B, lineC]);
    tryClaimMock.mockResolvedValue({ claimId: "claim-1", status: "CLAIMED" });
    resolveDeterministicMock.mockResolvedValue(null);
    buildShortlistMock.mockRejectedValueOnce(new Error("shortlist lookup timed out")).mockResolvedValueOnce([{ id: "cand-1", name: "Paper Towels" }]);
    runItemClassificationMock.mockResolvedValue({
      lines: [
        { lineKey: "line-b", candidateItemId: null, proposedName: null, proposedDisposition: null, proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: null, reasoning: null },
        { lineKey: "line-c", candidateItemId: "cand-1", proposedName: null, proposedDisposition: null, proposedCategoryId: null, proposedSpendCategoryId: null, proposedBaseUnitCode: null, confidence: 0.7, reasoning: null },
      ],
      issues: [],
      raw: {},
      model: "gemini-3.6-flash",
      provider: "gemini",
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await classifyPurchaseDocumentLines("pd-1", "org-1");

    expect(runItemClassificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [expect.objectContaining({ lineKey: "line-b", shortlist: [] }), expect.objectContaining({ lineKey: "line-c" })],
      expect.any(Set),
      "gemini-3.6-flash"
    );
    expect(recordAiSuggestedCandidateRpcMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lineKey: "line-c" }));
    expect(finishClaimMock).toHaveBeenCalledWith(expect.anything(), { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
    consoleErrorSpy.mockRestore();
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
