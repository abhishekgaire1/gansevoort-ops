import "server-only";
import type { AIProvider } from "@/app/lib/ai/provider";
import { extractInvoiceRaw, type ExtractInvoiceInput } from "./extract";
import { normalizeInvoiceExtraction } from "./normalize";
import { validateInvoiceExtraction } from "./validate";
import type { InvoiceExtractionResult } from "./types";

/**
 * The one exported entry point for this task -- everything outside this
 * folder (Server Actions, the dev test page) imports this, never
 * extract/normalize/validate individually, and never the provider directly.
 *
 * `model` is an optional override, used only by the dev test page's
 * side-by-side model comparison (Section 11 of the plan) -- production call
 * sites omit it and get the provider's configured default.
 */
export async function runInvoiceExtraction(
  provider: AIProvider,
  input: ExtractInvoiceInput,
  model?: string
): Promise<InvoiceExtractionResult> {
  const result = await extractInvoiceRaw(provider, input, model);
  const normalized = normalizeInvoiceExtraction(result.data);
  const { issues } = validateInvoiceExtraction(normalized);

  return {
    normalized,
    issues,
    raw: result.rawResponse,
    model: result.model,
    provider: result.provider,
  };
}
