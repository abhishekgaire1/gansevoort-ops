import { describe, expect, it } from "vitest";
import { ToolPlanSchema, SynthesisSchema } from "@/app/lib/ai/tasks/chat/schema";

// CI-safe: pure zod schema checks, no network, no database.

describe("24. model-invented evidence is structurally impossible", () => {
  it("SynthesisSchema has no evidence/url/link field the model could populate", () => {
    const parsed = SynthesisSchema.parse({
      answer: "answer",
      insufficientData: false,
      warning: null,
      // A model trying to sneak in its own evidence/url -- stripped by
      // zod's default parsing since the schema never declares these keys,
      // and the orchestrator never reads them even if present.
      evidence: [{ label: "Fake", href: "https://evil.example.com" }],
      url: "https://evil.example.com",
    } as unknown as Record<string, unknown>);
    expect(parsed).not.toHaveProperty("evidence");
    expect(parsed).not.toHaveProperty("url");
  });

  it("ToolPlanSchema rejects a tool name outside the allowlisted enum", () => {
    const result = ToolPlanSchema.safeParse({ requestType: "DATA_QUESTION", toolCalls: [{ tool: "run_arbitrary_sql", args: {} }] });
    expect(result.success).toBe(false);
  });

  it("ToolPlanSchema caps toolCalls at 4", () => {
    const result = ToolPlanSchema.safeParse({
      requestType: "DATA_QUESTION",
      toolCalls: Array.from({ length: 5 }, () => ({ tool: "get_inventory_status" })),
    });
    expect(result.success).toBe(false);
  });
});
