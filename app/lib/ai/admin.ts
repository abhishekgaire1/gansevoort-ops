import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AITaskKey } from "@/app/lib/ai/taskKeys";
import { CONFIGURABLE_AI_TASK_KEYS } from "@/app/lib/ai/taskKeys";
import { resolveAIApplicationDefault } from "@/app/lib/ai/router/resolveAIConfig";

/**
 * AI Configuration milestone -- the Admin-only read/write layer for
 * organization_ai_settings / organization_ai_task_settings. Read paths
 * here return the RESOLVED effective configuration (task override -> org
 * default -> app default, Part 11-12) alongside which level each value
 * actually came from, so the Configuration page can render "Use Default"
 * correctly and never invent a duplicate resolution algorithm client-side.
 */

export interface AIProviderModel {
  provider: string;
  model: string;
}

export type AIConfigSource = "task_override" | "organization_default" | "application_default";

export interface ResolvedTaskConfig {
  task: AITaskKey;
  effective: AIProviderModel;
  source: AIConfigSource;
  /** The explicit override row, if one exists -- null means "Use Default"
   * is currently selected for this task. */
  override: AIProviderModel | null;
}

export interface AIOrganizationConfiguration {
  /** null if the organization has never saved a default -- the
   * application fallback is shown as the effective default in that case. */
  organizationDefault: AIProviderModel | null;
  effectiveDefault: AIProviderModel;
  defaultSource: "organization_default" | "application_default";
  tasks: ResolvedTaskConfig[];
}

export async function getAIOrganizationConfiguration(supabase: SupabaseClient, organizationId: string): Promise<AIOrganizationConfiguration> {
  const [{ data: orgRow }, { data: taskRows }] = await Promise.all([
    supabase.from("organization_ai_settings").select("default_provider, default_model").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("organization_ai_task_settings").select("task_key, provider, model").eq("organization_id", organizationId),
  ]);

  const organizationDefault: AIProviderModel | null = orgRow ? { provider: orgRow.default_provider as string, model: orgRow.default_model as string } : null;
  const effectiveDefault = organizationDefault ?? resolveAIApplicationDefault();
  const defaultSource: "organization_default" | "application_default" = organizationDefault ? "organization_default" : "application_default";

  const overridesByTask = new Map<string, AIProviderModel>((taskRows ?? []).map((r) => [r.task_key as string, { provider: r.provider as string, model: r.model as string }]));

  const tasks: ResolvedTaskConfig[] = CONFIGURABLE_AI_TASK_KEYS.map((task) => {
    const override = overridesByTask.get(task) ?? null;
    return {
      task,
      override,
      effective: override ?? { provider: effectiveDefault.provider, model: effectiveDefault.model },
      source: override ? "task_override" : defaultSource,
    };
  });

  return { organizationDefault, effectiveDefault, defaultSource, tasks };
}

export async function setAIDefaultConfiguration(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, provider: string, model: string): Promise<void> {
  const { error } = await supabase.rpc("set_ai_default_configuration", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_provider: provider,
    p_model: model,
  });
  if (error) throw new Error(error.message);
}

/** provider/model both null clears the task override ("Use Default"). */
export async function setAITaskConfiguration(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  task: AITaskKey,
  provider: string | null,
  model: string | null
): Promise<void> {
  const { error } = await supabase.rpc("set_ai_task_configuration", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_task_key: task,
    p_provider: provider,
    p_model: model,
  });
  if (error) throw new Error(error.message);
}
