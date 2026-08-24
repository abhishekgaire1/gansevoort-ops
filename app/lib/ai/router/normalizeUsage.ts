import "server-only";
import { extractGeminiDebugMetadata } from "@/app/lib/ai/providers/gemini";

/**
 * AI Configuration + Usage/Cost Tracking milestone -- provider-returned
 * usage metadata, normalized into the common shape ai_usage_events
 * stores. Only concepts we can represent truthfully across providers are
 * common fields (Part 63); everything here comes directly from the
 * provider's own response, never estimated by counting characters (Part
 * 23) -- if a provider's response carries no usage metadata, every field
 * is null, not zero.
 */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  /** Gemini-specific "thinking" tokens (thoughtsTokenCount) -- kept as its
   * own nullable field rather than folded into outputTokens, since it is
   * not comparable across providers (Part 64). */
  thoughtsTokens: number | null;
}

export const UNKNOWN_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cachedInputTokens: null,
  thoughtsTokens: null,
};

export function normalizeProviderUsage(provider: string, rawResponse: unknown): NormalizedUsage {
  if (provider === "gemini") {
    const usage = extractGeminiDebugMetadata(rawResponse)?.usageMetadata;
    if (!usage) return UNKNOWN_USAGE;
    return {
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount,
      cachedInputTokens: usage.cachedContentTokenCount,
      thoughtsTokens: usage.thoughtsTokenCount,
    };
  }
  return UNKNOWN_USAGE;
}
