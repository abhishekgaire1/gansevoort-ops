import "server-only";
import { z } from "zod";
import { CHAT_TOOL_NAMES } from "@/app/lib/ai/tasks/chat/contract";

/**
 * Step 1 (tool selection): the model chooses a request classification and,
 * for a genuine data question, up to 4 tools from the fixed allowlist.
 * `args` is passed through as a plain JSON object here and validated
 * per-tool by toolRegistry.ts's own strict schema -- this outer schema
 * only constrains the SHAPE (tool name must be one of the allowlisted
 * enum values; nothing else is accepted).
 */
export const ToolPlanSchema = z.object({
  requestType: z.enum(["DATA_QUESTION", "ACTION_REQUEST", "OUT_OF_SCOPE"]),
  toolCalls: z
    .array(
      z.object({
        tool: z.enum(CHAT_TOOL_NAMES),
        args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      })
    )
    .max(4),
});
export type ToolPlan = z.infer<typeof ToolPlanSchema>;

/**
 * Step 2 (answer synthesis): given ONLY the already-fetched, already-
 * trusted tool data text (never raw DB access), the model produces the
 * final answer. It never re-emits a URL or evidence object itself --
 * those were already built server-side in evidence.ts from the tools
 * that actually ran.
 */
export const SynthesisSchema = z.object({
  answer: z.string().max(4000),
  insufficientData: z.boolean(),
  warning: z.string().nullable(),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;
