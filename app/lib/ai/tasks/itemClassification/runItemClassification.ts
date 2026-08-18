import "server-only";
import type { AIProvider } from "@/app/lib/ai/provider";
import { classifyItemsRaw } from "./extract";
import { normalizeItemClassification } from "./normalize";
import { validateItemClassification } from "./validate";
import type { ClassificationCandidateContext, ItemClassificationResult, ItemShortlistCandidate, UnresolvedClassificationLine } from "./types";

/** The one exported entry point for this task -- everything outside this
 * folder imports this, never extract/normalize/validate individually, and
 * never the provider directly (mirrors runInvoiceExtraction.ts). */
export async function runItemClassification(
  provider: AIProvider,
  context: ClassificationCandidateContext,
  lines: UnresolvedClassificationLine[],
  knownUnitCodes: Set<string>,
  model?: string
): Promise<ItemClassificationResult> {
  const result = await classifyItemsRaw(provider, context, lines, model);
  const normalized = normalizeItemClassification(result.data);

  const shortlistsByLineKey = new Map<string, ItemShortlistCandidate[]>(lines.map((l) => [l.lineKey, l.shortlist]));
  const { lines: validatedLines, issues } = validateItemClassification(normalized, shortlistsByLineKey, knownUnitCodes, context);

  return {
    lines: validatedLines,
    issues,
    raw: result.rawResponse,
    model: result.model,
    provider: result.provider,
  };
}
