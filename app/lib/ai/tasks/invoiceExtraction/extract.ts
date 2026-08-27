import "server-only";
import type { AIProvider, StructuredGenerationResult } from "@/app/lib/ai/provider";
import { GeminiInvoiceExtractionSchema, type GeminiInvoiceExtraction } from "./schema";
import { INVOICE_EXTRACTION_INSTRUCTIONS } from "./instructions";

export interface ExtractInvoiceFile {
  bytesBase64: string;
  mimeType: string;
}

/** One or more files, always in page order -- multi-page phone capture
 * feeds every page of ONE document through in a single call so Gemini
 * reasons across the whole document at once (consolidated header fields,
 * one combined `lines` array), never as N separately-merged single-page
 * extractions. The overwhelmingly common single-page document is simply a
 * one-element array. */
export interface ExtractInvoiceInput {
  files: ExtractInvoiceFile[];
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
    parts: input.files.map((file) => ({ type: "file" as const, mimeType: file.mimeType, data: file.bytesBase64 })),
    model,
  });
}
