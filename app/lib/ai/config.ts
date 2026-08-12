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
 *
 * Default changed to gemini-3.6-flash for Milestone 2A.1: real-document
 * testing during 2A.0 showed better extraction quality than
 * gemini-3.5-flash-lite, the original default.
 */

const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export function resolveGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}
