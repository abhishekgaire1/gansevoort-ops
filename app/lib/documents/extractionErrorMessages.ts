import type { AIProviderErrorCode } from "@/app/lib/ai/provider";

/**
 * Manager-facing only -- never the raw provider/internal error text, which
 * stays in document_extractions.error_message for server-side debugging.
 * No "server-only" guard: the document detail page's client component
 * needs this to render a retry/stalled state without round-tripping to the
 * server first. Only `AIProviderErrorCode`'s TYPE is imported from
 * app/lib/ai/provider.ts (a `server-only` module) -- a type-only import is
 * erased at compile time, so no runtime import of that module reaches the
 * client bundle.
 */
const EXTRACTION_ERROR_MESSAGES: Record<AIProviderErrorCode, string> = {
  PROVIDER_REQUEST_FAILED: "Couldn't reach the extraction service. Try again in a moment.",
  EMPTY_RESPONSE: "The extraction service returned no result. Try again.",
  INVALID_JSON: "The extraction service returned an unexpected response. Try again.",
  SCHEMA_VALIDATION_FAILED: "The extraction service returned data in an unexpected shape. Try again.",
};
const UNKNOWN_ERROR_MESSAGE = "Extraction failed for an unknown reason. Try again.";
const TIMED_OUT_ERROR_MESSAGE = "The extraction service didn't respond in time.";

export function safeExtractionErrorMessage(errorCode: string | null): string {
  if (errorCode === "TIMED_OUT") return TIMED_OUT_ERROR_MESSAGE;
  if (errorCode && errorCode in EXTRACTION_ERROR_MESSAGES) {
    return EXTRACTION_ERROR_MESSAGES[errorCode as AIProviderErrorCode];
  }
  return UNKNOWN_ERROR_MESSAGE;
}
