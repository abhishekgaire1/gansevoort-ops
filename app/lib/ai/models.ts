import type { AITaskKey } from "@/app/lib/ai/taskKeys";

/**
 * AI Configuration + Usage/Cost Tracking milestone -- the server-controlled
 * provider/model allowlist. An Admin picks from THIS list; nothing lets an
 * Admin type an arbitrary model string (Part 7). Deliberately a plain code
 * constant, not a database table: capabilities/display-name/enabled don't
 * need point-in-time history the way pricing does (see
 * app/lib/ai/pricing.ts and the ai_model_pricing table for the piece that
 * genuinely does need versioning), so a developer updates this file and
 * redeploys -- no migration, no seed script, matching how
 * app/lib/ai/config.ts's DEFAULT_GEMINI_MODEL already works.
 *
 * The two entries below are the ONLY Gemini model identifiers this
 * codebase has ever actually used (Phase A inspection: app/lib/ai/config.ts's
 * DEFAULT_GEMINI_MODEL and app/manager/(app)/ai-test/invoice's
 * COMPARISON_MODEL) -- not a speculative list of every model Google
 * publishes.
 */

export type AIProviderKey = "gemini";

/** No apiKeyEnvVar field here deliberately -- this module is imported by
 * client components (e.g. ConfigurationTab.tsx, for model-compatibility
 * checks), and an environment variable NAME must never reach the browser
 * bundle any more than its value would (Part 15/58). The provider ->
 * env-var-name mapping lives only in providerRegistry.ts, a server-only
 * file. */
export interface AIProviderMeta {
  key: AIProviderKey;
  displayName: string;
  /** Whether this provider has a working adapter -- the Admin Provider
   * selector only ever shows providers with supported: true (Part 6).
   * OpenAI/Anthropic have no adapter implementation yet, so they are
   * intentionally absent from this list entirely, not merely disabled. */
  supported: true;
}

export const AI_PROVIDERS: Record<AIProviderKey, AIProviderMeta> = {
  gemini: { key: "gemini", displayName: "Google Gemini", supported: true },
};

export interface AIModelMeta {
  provider: AIProviderKey;
  modelId: string;
  displayName: string;
  enabled: boolean;
  recommendedFor: string[];
  supportsStructuredOutput: boolean;
  /** Multimodal (image/PDF) input support -- required for
   * INVOICE_EXTRACTION, which sends the uploaded document itself as a
   * file part (see app/lib/ai/tasks/invoiceExtraction/extract.ts). */
  supportsDocuments: boolean;
}

export const AI_MODELS: AIModelMeta[] = [
  {
    provider: "gemini",
    modelId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    enabled: true,
    recommendedFor: ["Recommended", "High Capability"],
    supportsStructuredOutput: true,
    supportsDocuments: true,
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash Lite",
    enabled: true,
    recommendedFor: ["Fast", "Lower Cost"],
    supportsStructuredOutput: true,
    supportsDocuments: true,
  },
];

/** What each configurable task actually requires -- server-authoritative,
 * checked before ANY save (Part 47). Admin cannot assign a text-only
 * model to INVOICE_EXTRACTION merely because it appears in AI_MODELS;
 * today both allowlisted models satisfy both requirement sets, but this
 * check exists so a future text-only model addition can't be
 * accidentally assigned to a document task. */
export const AI_TASK_MODEL_REQUIREMENTS: Record<AITaskKey, { requiresStructuredOutput: boolean; requiresDocuments: boolean }> = {
  INVOICE_EXTRACTION: { requiresStructuredOutput: true, requiresDocuments: true },
  ITEM_CLASSIFICATION: { requiresStructuredOutput: true, requiresDocuments: false },
  CHAT: { requiresStructuredOutput: false, requiresDocuments: false },
};

export function findModel(provider: string, modelId: string): AIModelMeta | null {
  return AI_MODELS.find((m) => m.provider === provider && m.modelId === modelId) ?? null;
}

export function listEnabledModels(provider?: AIProviderKey): AIModelMeta[] {
  return AI_MODELS.filter((m) => m.enabled && (!provider || m.provider === provider));
}

/** Server-authoritative: true only if the model exists, is enabled, and
 * satisfies the given task's requirements. Called by the config-save RPC
 * path (via the TypeScript action layer, before the RPC is ever reached)
 * -- never trusts a client-supplied compatibility claim. */
export function isModelCompatibleWithTask(provider: string, modelId: string, task: AITaskKey): boolean {
  const model = findModel(provider, modelId);
  if (!model || !model.enabled) return false;
  const requirements = AI_TASK_MODEL_REQUIREMENTS[task];
  if (requirements.requiresStructuredOutput && !model.supportsStructuredOutput) return false;
  if (requirements.requiresDocuments && !model.supportsDocuments) return false;
  return true;
}
