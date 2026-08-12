/**
 * The single place a Gemini model identifier is allowed to appear as a
 * literal string. No business code (task modules, providers, actions,
 * pages) references a model name directly -- everything imports
 * `resolveGeminiModel()` -- so benchmarking a different model, or changing
 * the default once one is chosen, never means hunting through call sites.
 *
 * No automatic fallback/routing here by design (Milestone 2A.0): exactly
 * one configured model per run, so extraction-quality benchmarking stays
 * unambiguous about which model actually produced a given result.
 */

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export function resolveGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}
