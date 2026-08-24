import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AITaskKey } from "@/app/lib/ai/taskKeys";
import { resolveGeminiModel } from "@/app/lib/ai/config";

/**
 * AI Configuration milestone -- the precedence chain (Part 11-12):
 *
 *   task override  ->  organization default  ->  application default
 *
 * highest-specificity wins. The application default (Part 12) is the
 * existing env-var-driven resolveGeminiModel()/"gemini" pair -- so AI
 * workflows keep working even for an organization that has never opened
 * the Admin AI Configuration page.
 *
 * Deliberately a stateless read, not part of executeAITask (Part 20's own
 * wrapper): invoice extraction resolves configuration at ATTEMPT-CREATION
 * time (documentUpload.ts/documentExtraction.ts), before the row that
 * will freeze that provider/model immutably even exists yet -- the actual
 * AI call happens later (runDocumentExtractionAttempt.ts), reading the
 * already-fixed value back off that row rather than re-resolving (Part
 * 49-50: an in-flight attempt must keep the model it started with). Item
 * classification, which has no equivalent pre-existing attempt table,
 * calls this immediately before executeAITask instead. Both are valid
 * callers of the same resolution logic; only the TIMING differs, which is
 * an existing-architecture constraint, not a router design choice.
 */
export interface ResolvedAIConfig {
  provider: string;
  model: string;
  source: "task_override" | "organization_default" | "application_default";
}

const APPLICATION_DEFAULT_PROVIDER = "gemini";

export function resolveAIApplicationDefault(): ResolvedAIConfig {
  return { provider: APPLICATION_DEFAULT_PROVIDER, model: resolveGeminiModel(), source: "application_default" };
}

export async function resolveAIConfig(supabase: SupabaseClient, organizationId: string, task: AITaskKey): Promise<ResolvedAIConfig> {
  const { data: taskRow } = await supabase
    .from("organization_ai_task_settings")
    .select("provider, model")
    .eq("organization_id", organizationId)
    .eq("task_key", task)
    .maybeSingle();
  if (taskRow) {
    return { provider: taskRow.provider as string, model: taskRow.model as string, source: "task_override" };
  }

  const { data: orgRow } = await supabase
    .from("organization_ai_settings")
    .select("default_provider, default_model")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (orgRow) {
    return { provider: orgRow.default_provider as string, model: orgRow.default_model as string, source: "organization_default" };
  }

  return resolveAIApplicationDefault();
}
