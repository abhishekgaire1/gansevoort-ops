import "server-only";
import { GeminiProvider } from "@/app/lib/ai/providers/gemini";
import type { AIProvider } from "@/app/lib/ai/provider";
import type { AIProviderKey } from "@/app/lib/ai/models";

/**
 * AI Configuration milestone -- the ONE place a provider key maps to a
 * live adapter instance and its API key env var. This mapping is
 * deliberately kept out of app/lib/ai/models.ts (which client components
 * import for model-compatibility checks) -- an environment variable NAME
 * must never reach the browser bundle any more than its value would
 * (Part 13/15/58). Callers only ever get back either a working AIProvider
 * or this typed error, never the env var name or the key itself.
 */
const PROVIDER_API_KEY_ENV_VAR: Record<AIProviderKey, string> = {
  gemini: "GEMINI_API_KEY",
};
export class AIProviderUnavailableError extends Error {
  readonly providerKey: string;
  constructor(providerKey: string) {
    super(`AI provider "${providerKey}" is not configured on this environment.`);
    this.name = "AIProviderUnavailableError";
    this.providerKey = providerKey;
  }
}

export function isProviderConfigured(providerKey: string): boolean {
  const envVar = PROVIDER_API_KEY_ENV_VAR[providerKey as AIProviderKey];
  if (!envVar) return false;
  return Boolean(process.env[envVar]?.trim());
}

/** Throws AIProviderUnavailableError rather than returning null -- every
 * call site either gets a working provider or a controlled, typed
 * failure, never a silent client-side fallback (Part 58). */
export function instantiateProvider(providerKey: string): AIProvider {
  const envVar = PROVIDER_API_KEY_ENV_VAR[providerKey as AIProviderKey];
  const apiKey = envVar ? process.env[envVar]?.trim() : undefined;
  if (!envVar || !apiKey) {
    throw new AIProviderUnavailableError(providerKey);
  }

  switch (providerKey as AIProviderKey) {
    case "gemini":
      return new GeminiProvider(apiKey);
    default:
      throw new AIProviderUnavailableError(providerKey);
  }
}
