import "server-only";
import type { AIProvider, StructuredGenerationResult } from "@/app/lib/ai/provider";
import { GeminiInvoiceExtractionSchema, type GeminiInvoiceExtraction } from "./schema";
import { INVOICE_EXTRACTION_INSTRUCTIONS } from "./instructions";

export interface ExtractInvoiceInput {
  fileBytesBase64: string;
  mimeType: string;
}

/** Calls the provider with this task's own schema + instructions. Returns
 * the raw (still Gemini-schema-shaped) structured result -- callers should
 * go through normalize.ts, not consume this directly. */
export async function extractInvoiceRaw(
  provider: AIProvider,
  input: ExtractInvoiceInput,
  model?: string
): Promise<StructuredGenerationResult<GeminiInvoiceExtraction>> {
  return provider.generateStructuredOutput<GeminiInvoiceExtraction>({
    systemInstructions: INVOICE_EXTRACTION_INSTRUCTIONS,
    schema: GeminiInvoiceExtractionSchema,
    parts: [{ type: "file", mimeType: input.mimeType, data: input.fileBytesBase64 }],
    model,
  });
}
