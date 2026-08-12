"use server";

import { GeminiProvider, extractGeminiDebugMetadata, type GeminiDebugMetadata } from "@/app/lib/ai/providers/gemini";
import { AIProviderError } from "@/app/lib/ai/provider";
import { runInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction";
import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Dev-test-harness Server Action only (app/manager/ai-test/invoice) --
 * Milestone 2A.0 has no receiving workflow yet to call this from. Accepts a
 * raw upload directly; nothing is persisted to Supabase Storage or any
 * database table.
 *
 * Serialization boundary: `runInvoiceExtraction`'s internal
 * InvoiceExtractionResult still carries `raw` (the full Gemini SDK
 * response -- a class instance, not serializable to a Client Component,
 * and the shape a future document_extractions table would persist). This
 * action is the one place that gets mapped down to a plain, client-safe
 * DTO before returning -- never returned as-is.
 */

/** What actually crosses the Server Action -> Client Component boundary.
 * Plain data only -- no SDK class instances, no sdkHttpResponse, no raw
 * candidates. */
export interface InvoiceExtractionClientResult {
  normalized: NormalizedInvoiceExtraction;
  issues: ReviewFlag[];
  model: string;
  provider: string;
  debugMetadata: GeminiDebugMetadata | null;
}

// 20MB: the authoritative application-level limit for this test harness.
// Independent of next.config.ts's serverActions.bodySizeLimit (25mb) --
// that config only raises the transport-level ceiling so a request under
// this limit isn't rejected before reaching this function; it is never
// treated as our file-size validation.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_MB = MAX_FILE_BYTES / (1024 * 1024);

const ACCEPTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

// Magic-byte signatures -- the browser-reported File.type is checked but
// not solely trusted; the server independently inspects the leading bytes.
function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf";
  }
  return null;
}

export type ExtractInvoiceActionResult =
  | { ok: true; result: InvoiceExtractionClientResult }
  | { ok: false; reason: "invalid_file_type" | "file_too_large" | "extraction_failed" | "misconfigured"; message: string };

export async function extractInvoiceFromUpload(formData: FormData, compareModel?: string): Promise<ExtractInvoiceActionResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "misconfigured", message: "GEMINI_API_KEY is not set." };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, reason: "invalid_file_type", message: "No file was uploaded." };
  }
  if (file.size === 0) {
    return { ok: false, reason: "invalid_file_type", message: "The uploaded file is empty." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "file_too_large", message: `Invoice files must be ${MAX_FILE_MB} MB or smaller.` };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffedMimeType = sniffMimeType(buffer);
  if (!sniffedMimeType || !ACCEPTED_MIME_TYPES.has(sniffedMimeType)) {
    return {
      ok: false,
      reason: "invalid_file_type",
      message: "Unsupported file type. This test harness accepts JPEG, PNG, and PDF only (HEIC is not yet supported).",
    };
  }

  const provider = new GeminiProvider(apiKey);

  try {
    const result = await runInvoiceExtraction(
      provider,
      { fileBytesBase64: buffer.toString("base64"), mimeType: sniffedMimeType },
      compareModel
    );
    // The mapping step: `result.raw` (the Gemini SDK response) is
    // deliberately dropped here, never spread/returned directly. Only
    // scalar debug fields, picked by extractGeminiDebugMetadata, survive.
    return {
      ok: true,
      result: {
        normalized: result.normalized,
        issues: result.issues,
        model: result.model,
        provider: result.provider,
        debugMetadata: extractGeminiDebugMetadata(result.raw),
      },
    };
  } catch (err) {
    if (err instanceof AIProviderError) {
      return { ok: false, reason: "extraction_failed", message: err.message };
    }
    return { ok: false, reason: "extraction_failed", message: err instanceof Error ? err.message : "Extraction failed for an unknown reason." };
  }
}
