import "server-only";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { resolveGeminiModel } from "@/app/lib/ai/config";
import {
  AIProviderError,
  type AIProvider,
  type StructuredGenerationInput,
  type StructuredGenerationResult,
} from "@/app/lib/ai/provider";

/**
 * Wraps @google/genai's structured-output support directly -- the response
 * schema is derived from the SAME Zod schema the caller also parses the
 * response against (via Zod v4's built-in `z.toJSONSchema`), so there is
 * exactly one schema definition, not two that could drift. This is the
 * "current official Gemini SDK structured-output/Zod support" path: no
 * separate zod-to-json-schema dependency.
 */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateStructuredOutput<T>(input: StructuredGenerationInput<T>): Promise<StructuredGenerationResult<T>> {
    const model = input.model ?? resolveGeminiModel();

    const parts = input.parts.map((part) =>
      part.type === "text" ? { text: part.text } : { inlineData: { mimeType: part.mimeType, data: part.data } }
    );

    let response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
    try {
      response = await this.client.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: input.systemInstructions,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(input.schema),
        },
      });
    } catch (err) {
      throw new AIProviderError("PROVIDER_REQUEST_FAILED", `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`, err);
    }

    const text = response.text;
    if (!text) {
      throw new AIProviderError("EMPTY_RESPONSE", "Gemini returned no text content");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      throw new AIProviderError("INVALID_JSON", "Gemini's response was not valid JSON", err);
    }

    const validated = input.schema.safeParse(parsedJson);
    if (!validated.success) {
      throw new AIProviderError(
        "SCHEMA_VALIDATION_FAILED",
        `Gemini's response did not match the expected schema: ${validated.error.message}`,
        validated.error
      );
    }

    return {
      data: validated.data,
      rawResponse: response,
      model,
      provider: this.name,
    };
  }
}

/**
 * Gemini-specific: `rawResponse` here is a `GenerateContentResponse` SDK
 * class instance -- it (and nested fields like `usageMetadata`, which is
 * itself a `GenerateContentResponseUsageMetadata` class instance, plus an
 * `sdkHttpResponse` handle and full `candidates` array) is server-only and
 * must never cross the Server Action -> Client Component boundary: "only
 * plain objects... can be passed to Client Components... Classes or null
 * prototypes are not supported."
 *
 * This is the one place that boundary is crossed deliberately and
 * intentionally: it picks exactly the scalar debug fields worth surfacing
 * in the dev test harness and returns a plain object -- never
 * JSON.stringify/parse of the whole SDK response, which would silently
 * carry along whatever nested shape the SDK happens to have today.
 */
export interface GeminiDebugMetadata {
  responseId: string | null;
  modelVersion: string | null;
  usageMetadata: {
    promptTokenCount: number | null;
    candidatesTokenCount: number | null;
    totalTokenCount: number | null;
    cachedContentTokenCount: number | null;
    thoughtsTokenCount: number | null;
    toolUsePromptTokenCount: number | null;
  } | null;
}

export function extractGeminiDebugMetadata(rawResponse: unknown): GeminiDebugMetadata | null {
  if (!rawResponse || typeof rawResponse !== "object") {
    return null;
  }

  const response = rawResponse as {
    responseId?: unknown;
    modelVersion?: unknown;
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
      cachedContentTokenCount?: unknown;
      thoughtsTokenCount?: unknown;
      toolUsePromptTokenCount?: unknown;
    };
  };

  const usage = response.usageMetadata;

  return {
    responseId: typeof response.responseId === "string" ? response.responseId : null,
    modelVersion: typeof response.modelVersion === "string" ? response.modelVersion : null,
    usageMetadata: usage
      ? {
          promptTokenCount: numberOrNull(usage.promptTokenCount),
          candidatesTokenCount: numberOrNull(usage.candidatesTokenCount),
          totalTokenCount: numberOrNull(usage.totalTokenCount),
          cachedContentTokenCount: numberOrNull(usage.cachedContentTokenCount),
          thoughtsTokenCount: numberOrNull(usage.thoughtsTokenCount),
          toolUsePromptTokenCount: numberOrNull(usage.toolUsePromptTokenCount),
        }
      : null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Milestone 2A.1: the broader, DB-persisted counterpart to
 * extractGeminiDebugMetadata above -- that function is scoped only to what
 * the dev harness displays; this one captures what's worth keeping in
 * document_extractions.provider_metadata for debugging/reprocessing a real
 * extraction attempt without a re-call. Same defensive pattern (explicit
 * allow-listed fields, typed guards, never a blind JSON.stringify of the
 * whole SDK object) but broader: full usageMetadata (not just 6 fields),
 * per-candidate finishReason + a safety-ratings summary, and the raw
 * response text the extraction was parsed from. Still explicitly excludes
 * sdkHttpResponse/any transport object and never stores secrets.
 */
export interface SanitizedGeminiModalityTokenCount {
  modality: string | null;
  tokenCount: number | null;
}

export interface SanitizedGeminiUsageMetadata {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  totalTokenCount: number | null;
  cachedContentTokenCount: number | null;
  thoughtsTokenCount: number | null;
  toolUsePromptTokenCount: number | null;
  promptTokensDetails: SanitizedGeminiModalityTokenCount[] | null;
  candidatesTokensDetails: SanitizedGeminiModalityTokenCount[] | null;
}

export interface SanitizedGeminiSafetyRating {
  category: string | null;
  probability: string | null;
}

export interface SanitizedGeminiCandidate {
  finishReason: string | null;
  safetyRatings: SanitizedGeminiSafetyRating[] | null;
}

export interface SanitizedGeminiResponse {
  responseId: string | null;
  modelVersion: string | null;
  responseText: string | null;
  usageMetadata: SanitizedGeminiUsageMetadata | null;
  candidates: SanitizedGeminiCandidate[] | null;
}

function sanitizeModalityTokenCounts(value: unknown): SanitizedGeminiModalityTokenCount[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    const item = entry as { modality?: unknown; tokenCount?: unknown };
    return {
      modality: typeof item.modality === "string" ? item.modality : null,
      tokenCount: numberOrNull(item.tokenCount),
    };
  });
}

export function sanitizeGeminiRawResponse(rawResponse: unknown): SanitizedGeminiResponse | null {
  if (!rawResponse || typeof rawResponse !== "object") {
    return null;
  }

  const response = rawResponse as {
    responseId?: unknown;
    modelVersion?: unknown;
    text?: unknown;
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
      cachedContentTokenCount?: unknown;
      thoughtsTokenCount?: unknown;
      toolUsePromptTokenCount?: unknown;
      promptTokensDetails?: unknown;
      candidatesTokensDetails?: unknown;
    };
    candidates?: unknown;
  };

  const usage = response.usageMetadata;
  const candidatesArray = Array.isArray(response.candidates) ? response.candidates : null;

  return {
    responseId: typeof response.responseId === "string" ? response.responseId : null,
    modelVersion: typeof response.modelVersion === "string" ? response.modelVersion : null,
    responseText: typeof response.text === "string" ? response.text : null,
    usageMetadata: usage
      ? {
          promptTokenCount: numberOrNull(usage.promptTokenCount),
          candidatesTokenCount: numberOrNull(usage.candidatesTokenCount),
          totalTokenCount: numberOrNull(usage.totalTokenCount),
          cachedContentTokenCount: numberOrNull(usage.cachedContentTokenCount),
          thoughtsTokenCount: numberOrNull(usage.thoughtsTokenCount),
          toolUsePromptTokenCount: numberOrNull(usage.toolUsePromptTokenCount),
          promptTokensDetails: sanitizeModalityTokenCounts(usage.promptTokensDetails),
          candidatesTokensDetails: sanitizeModalityTokenCounts(usage.candidatesTokensDetails),
        }
      : null,
    candidates: candidatesArray
      ? candidatesArray.map((candidate) => {
          const c = candidate as { finishReason?: unknown; safetyRatings?: unknown };
          const safetyRatings = Array.isArray(c.safetyRatings)
            ? c.safetyRatings.map((rating) => {
                const r = rating as { category?: unknown; probability?: unknown };
                return {
                  category: typeof r.category === "string" ? r.category : null,
                  probability: typeof r.probability === "string" ? r.probability : null,
                };
              })
            : null;
          return {
            finishReason: typeof c.finishReason === "string" ? c.finishReason : null,
            safetyRatings,
          };
        })
      : null,
  };
}
