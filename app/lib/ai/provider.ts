import "server-only";
import type { z } from "zod";

/**
 * The generic AI provider capability: "produce output conforming to this
 * Zod schema, given these instructions and content parts." This is
 * deliberately narrow -- not a free-text `askAI(prompt)` escape hatch.
 * Nothing outside a dedicated task module (app/lib/ai/tasks/<task>/) is
 * meant to call a provider directly or supply its own ad-hoc instructions;
 * every business call site imports a task's typed entry point instead (see
 * app/lib/ai/tasks/invoiceExtraction/runInvoiceExtraction.ts).
 *
 * Server-only: every provider implementation holds an API key and must
 * never be importable from client-bundled code.
 */

export type AIContentPart =
  | { type: "text"; text: string }
  | { type: "file"; mimeType: string; data: string /* base64 */ };

export interface StructuredGenerationInput<T> {
  /** System-level instructions owned by the calling task module -- never a
   * caller-supplied free-text prompt. */
  systemInstructions: string;
  schema: z.ZodType<T>;
  parts: AIContentPart[];
  /** Optional override; defaults to the provider's own configured model
   * (see app/lib/ai/config.ts) when omitted. */
  model?: string;
}

export interface StructuredGenerationResult<T> {
  data: T;
  /** The provider's raw response, retained for debugging/audit -- shaped
   * to be usable later by a document_extractions-style table without
   * rework, though no such table exists yet (Milestone 2A.0 persists
   * nothing). */
  rawResponse: unknown;
  model: string;
  provider: string;
}

export type AIProviderErrorCode =
  | "PROVIDER_REQUEST_FAILED"
  | "EMPTY_RESPONSE"
  | "INVALID_JSON"
  | "SCHEMA_VALIDATION_FAILED";

/**
 * A controlled, typed failure -- distinct from an unhandled exception. Every
 * provider implementation must throw this (never a bare Error) so callers
 * can branch on `.code` rather than string-matching a message.
 */
export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly cause?: unknown;

  constructor(code: AIProviderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.cause = cause;
  }
}

export interface AIProvider {
  readonly name: string;
  generateStructuredOutput<T>(input: StructuredGenerationInput<T>): Promise<StructuredGenerationResult<T>>;
}
