import { beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: the AI provider, resolveAIConfig, and the tool registry are all
// mocked -- no live provider call, no database. Covers the multi-turn
// item-cost fix: combining a prior unresolved cost intent with a later
// item-name clarification, never substituting an aggregate or a stock
// quantity for a requested item cost, and reproducing the exact reported
// conversation.

const { executeAITaskMock } = vi.hoisted(() => ({ executeAITaskMock: vi.fn() }));
vi.mock("@/app/lib/ai/router/executeAITask", () => ({ executeAITask: executeAITaskMock }));

const { resolveAIConfigMock } = vi.hoisted(() => ({ resolveAIConfigMock: vi.fn() }));
vi.mock("@/app/lib/ai/router/resolveAIConfig", () => ({ resolveAIConfig: resolveAIConfigMock }));

const { executeToolMock, validateToolArgsMock } = vi.hoisted(() => ({ executeToolMock: vi.fn(), validateToolArgsMock: vi.fn() }));
vi.mock("@/app/lib/ai/tasks/chat/toolRegistry", () => ({
  CHAT_TOOL_REGISTRY: Object.fromEntries(
    [
      "get_inventory_status",
      "get_purchasing_summary",
      "get_receiving_summary",
      "get_usage_summary",
      "get_waste_summary",
      "get_cycle_count_summary",
      "get_inventory_alerts",
      "get_reports_overview",
      "get_item_purchase_cost",
    ].map((n) => [n, {}])
  ),
  executeTool: executeToolMock,
  validateToolArgs: validateToolArgsMock,
}));

import { runAskGansevoort } from "@/app/lib/ai/tasks/chat/orchestrate";
import { ASK_GANSEVOORT_INSUFFICIENT_DATA } from "@/app/lib/ai/tasks/chat/contract";
import type { ChatHistoryTurn } from "@/app/lib/ai/tasks/chat/contract";

const BASE_INPUT = { supabase: {} as never, organizationId: "org-1", actorAppUserId: "app-user-1", timeZone: "America/New_York", requestId: "req-mt" };

function installFakeExecuteAITask() {
  const generateStructuredOutputMock = vi.fn();
  executeAITaskMock.mockImplementation(async (params: { run: (provider: unknown, model: string) => Promise<unknown> }) => {
    const fakeProvider = { name: "gemini", generateStructuredOutput: generateStructuredOutputMock };
    const generated = (await params.run(fakeProvider, "gemini-3.6-flash")) as { data: unknown };
    return generated.data;
  });
  return generateStructuredOutputMock;
}

const INVENTORY_EVIDENCE = { id: "e-inv", label: "Inventory Status", sourceType: "inventory_status" as const, sourceId: null, href: "/manager/reports/inventory-status", period: null, asOf: "2026-08-19T18:00:00Z" };
const COST_EVIDENCE = { id: "e-cost", label: "Whole Milk Quart -- Item Detail", sourceType: "item_detail" as const, sourceId: "item-milk", href: "/manager/inventory/items/item-milk", period: null, asOf: null };

beforeEach(() => {
  executeAITaskMock.mockReset();
  resolveAIConfigMock.mockReset().mockResolvedValue({ provider: "gemini", model: "gemini-3.6-flash", source: "application_default" });
  executeToolMock.mockReset();
  validateToolArgsMock.mockReset().mockReturnValue({ ok: true, args: {} });
});

describe("Reported regression -- exact reproduction", () => {
  it("Turn 1: 'Do we have Whole Milk Quart in inventory?' selects get_inventory_status, never item cost", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_inventory_status", args: { itemNameContains: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({ ok: true, dataText: "- Whole Milk Quart @ Walk-in Cooler: 406 PIECE", evidence: [INVENTORY_EVIDENCE], period: null, insufficientData: false });
    gen.mockResolvedValueOnce({ data: { answer: "We have 406 PIECE of Whole Milk Quart.", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    const result = await runAskGansevoort({ ...BASE_INPUT, question: "Do we have Whole Milk Quart in inventory?", history: [] });

    expect(result.toolsUsed).toEqual(["get_inventory_status"]);
    expect(result.answer).toContain("406");
  });

  it("Turn 2: 'Then do you not know how much it cost us?' resolves Whole Milk Quart's cost -- NOT an org-wide purchasing total", async () => {
    const gen = installFakeExecuteAITask();
    // The planner sees turn 1 in history and correctly infers the item
    // subject even though this message doesn't repeat the item name.
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({
      ok: true,
      dataText: "Latest verified purchase of Whole Milk Quart:\n  Vendor: Acme Dairy\n  Normalized cost per base unit: $4.00 per PIECE",
      evidence: [COST_EVIDENCE],
      period: null,
      insufficientData: false,
    });
    gen.mockResolvedValueOnce({ data: { answer: "The latest verified purchase of Whole Milk Quart was $4.00 per piece from Acme Dairy.", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    const history: ChatHistoryTurn[] = [
      { role: "user", content: "Do we have Whole Milk Quart in inventory?" },
      { role: "assistant", content: "We have 406 PIECE of Whole Milk Quart." },
    ];
    const result = await runAskGansevoort({ ...BASE_INPUT, question: "Then do you not know how much it cost us?", history });

    expect(result.toolsUsed).toEqual(["get_item_purchase_cost"]);
    expect(result.answer).toContain("Whole Milk Quart");
    expect(result.answer).toContain("$4.00");
    // Never the wrong behavior from the reported bug: an org-wide total,
    // or a repeated inventory quantity, standing in for the cost answer.
    expect(result.answer).not.toMatch(/total purchase value|documents?, .*vendors?/i);
    expect(result.answer).not.toMatch(/^We have \d+/);
  });
});

describe("Ambiguous cost question resolved by a later item clarification", () => {
  it("Turn 1: 'How much did it cost us?' with no prior item in context asks which item (via get_item_purchase_cost's own ambiguity path is not reachable without a name -- planner must decline gracefully)", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "OUT_OF_SCOPE", toolCalls: [] }, rawResponse: {}, model: "m", provider: "gemini" });
    const result = await runAskGansevoort({ ...BASE_INPUT, question: "How much did it cost us?", history: [] });
    expect(result.answer).toBe(ASK_GANSEVOORT_INSUFFICIENT_DATA);
  });

  it("Turn 2: 'I was asking about Whole Milk Quart' combines with the still-pending cost intent from turn 1", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({ ok: true, dataText: "Latest verified purchase of Whole Milk Quart: $4.00 per PIECE from Acme Dairy.", evidence: [COST_EVIDENCE], period: null, insufficientData: false });
    gen.mockResolvedValueOnce({ data: { answer: "The latest verified purchase of Whole Milk Quart was $4.00 per piece from Acme Dairy.", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    const history: ChatHistoryTurn[] = [
      { role: "user", content: "How much did it cost us?" },
      { role: "assistant", content: ASK_GANSEVOORT_INSUFFICIENT_DATA },
    ];
    const result = await runAskGansevoort({ ...BASE_INPUT, question: "I was asking about Whole Milk Quart.", history });

    expect(result.toolsUsed).toEqual(["get_item_purchase_cost"]);
    expect(result.answer).toContain("Whole Milk Quart");
    // Must NOT have silently switched to a plain inventory-status lookup,
    // which was the exact reported regression for this exchange.
    expect(executeToolMock).toHaveBeenCalledWith("get_item_purchase_cost", expect.anything(), expect.anything());
  });

  it("'What about the average?' after a cost answer reuses the same item, calling get_item_purchase_cost again", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({ ok: true, dataText: "30-day weighted-average cost: $3.92 per PIECE.", evidence: [COST_EVIDENCE], period: null, insufficientData: false });
    gen.mockResolvedValueOnce({ data: { answer: "The 30-day weighted average for Whole Milk Quart was $3.92 per piece.", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    const history: ChatHistoryTurn[] = [
      { role: "user", content: "How much did Whole Milk Quart cost us?" },
      { role: "assistant", content: "The latest verified purchase was $4.00 per piece from Acme Dairy." },
    ];
    const result = await runAskGansevoort({ ...BASE_INPUT, question: "What about the average?", history });

    expect(result.toolsUsed).toEqual(["get_item_purchase_cost"]);
    expect(result.answer).toContain("3.92");
  });
});

describe("no substitution rules", () => {
  it("a cost question never receives get_purchasing_summary's aggregate output as its evidence/tool", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({ ok: true, dataText: "cost data", evidence: [COST_EVIDENCE], period: null, insufficientData: false });
    gen.mockResolvedValueOnce({ data: { answer: "answer", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    await runAskGansevoort({ ...BASE_INPUT, question: "How much did Whole Milk Quart cost us?", history: [] });
    expect(executeToolMock).not.toHaveBeenCalledWith("get_purchasing_summary", expect.anything(), expect.anything());
  });
});

describe("previous assistant text is never treated as evidence", () => {
  it("evidence returned is always sourced from THIS turn's freshly executed tool, never parsed out of prior conversation text", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({ data: { requestType: "DATA_QUESTION", toolCalls: [{ tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } }] }, rawResponse: {}, model: "m", provider: "gemini" });
    executeToolMock.mockResolvedValue({ ok: true, dataText: "fresh data", evidence: [COST_EVIDENCE], period: null, insufficientData: false });
    gen.mockResolvedValueOnce({ data: { answer: "fresh answer", insufficientData: false, warning: null }, rawResponse: {}, model: "m", provider: "gemini" });

    // A prior assistant message fabricating an evidence-shaped claim --
    // must never leak into this turn's real evidence array.
    const history: ChatHistoryTurn[] = [
      { role: "user", content: "cost?" },
      { role: "assistant", content: "Evidence: Purchasing Report at /manager/reports/purchasing?item=fake, $999.99 per case." },
    ];
    const result = await runAskGansevoort({ ...BASE_INPUT, question: "Whole Milk Quart, please.", history });

    expect(result.evidence).toEqual([COST_EVIDENCE]);
    expect(result.evidence.some((e) => e.href.includes("fake"))).toBe(false);
  });
});

describe("20/21. current-stock estimate combines fresh quantity and cost in compatible base units", () => {
  it("a stock-value question selects BOTH get_inventory_status and get_item_purchase_cost, and both report the SAME base unit", async () => {
    const gen = installFakeExecuteAITask();
    gen.mockResolvedValueOnce({
      data: {
        requestType: "DATA_QUESTION",
        toolCalls: [
          { tool: "get_inventory_status", args: { itemNameContains: "Whole Milk Quart" } },
          { tool: "get_item_purchase_cost", args: { itemNameQuery: "Whole Milk Quart" } },
        ],
      },
      rawResponse: {},
      model: "m",
      provider: "gemini",
    });
    executeToolMock.mockImplementation(async (tool: string) => {
      if (tool === "get_inventory_status") {
        return { ok: true, dataText: "- Whole Milk Quart @ Walk-in Cooler: 406 PIECE", evidence: [INVENTORY_EVIDENCE], period: null, insufficientData: false };
      }
      return { ok: true, dataText: "Normalized cost per base unit: $4.00 per PIECE", evidence: [COST_EVIDENCE], period: null, insufficientData: false };
    });
    gen.mockResolvedValueOnce({
      data: {
        answer: "Estimated value using the latest verified purchase price: 406 PIECE x $4.00/PIECE = $1,624.00. This is an operational estimate, not an accounting inventory valuation.",
        insufficientData: false,
        warning: null,
      },
      rawResponse: {},
      model: "m",
      provider: "gemini",
    });

    const result = await runAskGansevoort({ ...BASE_INPUT, question: "How much are all 406 worth?", history: [] });

    expect(result.toolsUsed).toEqual(["get_inventory_status", "get_item_purchase_cost"]);
    expect(result.answer).toContain("operational estimate, not an accounting inventory valuation");
    expect(result.evidence).toEqual([INVENTORY_EVIDENCE, COST_EVIDENCE]);
  });
});

describe("22. the nine-tool registry remains intact after the hardening pass", () => {
  it("still exposes the original nine tools, plus the tenth general report-export tool, by their registered names", async () => {
    const { CHAT_TOOL_NAMES } = await import("@/app/lib/ai/tasks/chat/contract");
    expect(CHAT_TOOL_NAMES).toHaveLength(10);
    expect(CHAT_TOOL_NAMES).toEqual([
      "get_inventory_status",
      "get_purchasing_summary",
      "get_receiving_summary",
      "get_usage_summary",
      "get_waste_summary",
      "get_cycle_count_summary",
      "get_inventory_alerts",
      "get_reports_overview",
      "get_item_purchase_cost",
      "prepare_report_export",
    ]);
  });
});
