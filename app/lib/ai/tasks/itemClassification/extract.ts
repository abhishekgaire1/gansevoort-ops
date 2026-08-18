import "server-only";
import type { AIProvider, StructuredGenerationResult } from "@/app/lib/ai/provider";
import { GeminiItemClassificationSchema, type GeminiItemClassification } from "./schema";
import { ITEM_CLASSIFICATION_INSTRUCTIONS } from "./instructions";
import type { ClassificationCandidateContext, UnresolvedClassificationLine } from "./types";

/** Serializes the org-wide candidate context (once) plus the unresolved
 * lines (each with its own org-scoped item shortlist) as the text content
 * part -- there is no file/image input for this task, only structured text
 * derived from already-persisted data. */
export async function classifyItemsRaw(
  provider: AIProvider,
  context: ClassificationCandidateContext,
  lines: UnresolvedClassificationLine[],
  model?: string
): Promise<StructuredGenerationResult<GeminiItemClassification>> {
  return provider.generateStructuredOutput<GeminiItemClassification>({
    systemInstructions: ITEM_CLASSIFICATION_INSTRUCTIONS,
    schema: GeminiItemClassificationSchema,
    parts: [{ type: "text", text: JSON.stringify({ context, lines }) }],
    model,
  });
}
