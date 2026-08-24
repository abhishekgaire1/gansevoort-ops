"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAIOrganizationConfiguration, setAIDefaultConfiguration, setAITaskConfiguration, type AIOrganizationConfiguration } from "@/app/lib/ai/admin";
import { AI_MODELS, AI_PROVIDERS, findModel, isModelCompatibleWithTask } from "@/app/lib/ai/models";
import { isAITaskKey, type AITaskKey } from "@/app/lib/ai/taskKeys";
import { isProviderConfigured } from "@/app/lib/ai/router/providerRegistry";
import { executeAITask, AIProviderUnavailableError } from "@/app/lib/ai/router/executeAITask";
import { AIProviderError } from "@/app/lib/ai/provider";

/**
 * AI Configuration milestone -- Admin-only Server Actions for
 * /manager/admin/ai. Every mutation gates on requireAdmin(); the model
 * allowlist + task/model compatibility check (app/lib/ai/models.ts) is
 * re-validated here server-side before either configuration RPC is ever
 * called (Part 47) -- never trusts a client-supplied claim that a model
 * is valid/compatible.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export interface AIConfigurationView {
  configuration: AIOrganizationConfiguration;
  providers: { key: string; displayName: string; connected: boolean }[];
  models: { provider: string; modelId: string; displayName: string; recommendedFor: string[] }[];
}

export type GetAIConfigurationResult = { ok: true; view: AIConfigurationView } | AuthFailure;

export async function getAIConfigurationAction(): Promise<GetAIConfigurationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const configuration = await getAIOrganizationConfiguration(getServiceRoleClient(), auth.manager.organizationId);

  return {
    ok: true,
    view: {
      configuration,
      providers: Object.values(AI_PROVIDERS).map((p) => ({ key: p.key, displayName: p.displayName, connected: isProviderConfigured(p.key) })),
      models: AI_MODELS.filter((m) => m.enabled).map((m) => ({ provider: m.provider, modelId: m.modelId, displayName: m.displayName, recommendedFor: m.recommendedFor })),
    },
  };
}

export type SaveAIConfigResult = { ok: true } | AuthFailure | { ok: false; reason: "invalid"; message: string };

export async function saveAIDefaultConfigurationAction(provider: string, model: string): Promise<SaveAIConfigResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!findModel(provider, model)) {
    return { ok: false, reason: "invalid", message: "That model is not on the approved list." };
  }

  try {
    await setAIDefaultConfiguration(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, provider, model);
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid", message: "Unable to save AI configuration." };
  }
}

/** provider/model both null/omitted means "Use Default" (Part 11). */
export async function saveAITaskConfigurationAction(taskKey: string, provider: string | null, model: string | null): Promise<SaveAIConfigResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!isAITaskKey(taskKey)) {
    return { ok: false, reason: "invalid", message: "Unsupported AI task." };
  }
  const task: AITaskKey = taskKey;

  if (provider !== null || model !== null) {
    if (!provider || !model || !isModelCompatibleWithTask(provider, model, task)) {
      return { ok: false, reason: "invalid", message: `The selected model is not available for ${task === "INVOICE_EXTRACTION" ? "Invoice Extraction" : "Item Classification"}.` };
    }
  }

  try {
    await setAITaskConfiguration(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, task, provider, model);
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid", message: "Unable to save AI configuration." };
  }
}

const TEST_CONFIGURATION_SCHEMA = z.object({ ok: z.literal(true) });

export type TestAIConfigurationResult =
  | { ok: true; provider: string; model: string; durationMs: number }
  | AuthFailure
  | { ok: false; reason: "unavailable"; message: string };

/** A very small, safe, real provider call (Part 16-17) -- no business
 * records touched, no document uploaded. Still a real billable request
 * when using the real provider, so it is recorded through the exact same
 * executeAITask usage-ledger path as operational calls, tagged
 * CONFIGURATION_TEST (Part 17) so it's distinguishable in Usage & Cost,
 * never hidden. */
export async function testAIConfigurationAction(provider: string, model: string): Promise<TestAIConfigurationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!findModel(provider, model)) {
    return { ok: false, reason: "unavailable", message: "The selected model is not available." };
  }
  if (!isProviderConfigured(provider)) {
    return { ok: false, reason: "unavailable", message: "Configuration unavailable. Provider credentials are not configured on this environment." };
  }

  const startedAt = Date.now();
  try {
    await executeAITask({
      organizationId: auth.manager.organizationId,
      task: "CONFIGURATION_TEST",
      provider,
      model,
      requestKey: randomUUID(),
      actorAppUserId: auth.manager.appUserId,
      run: async (providerAdapter, resolvedModel) => {
        const generated = await providerAdapter.generateStructuredOutput({
          systemInstructions: "You are verifying AI provider connectivity for an application admin. Respond only with the requested JSON, nothing else.",
          schema: TEST_CONFIGURATION_SCHEMA,
          parts: [{ type: "text", text: 'Reply with exactly this JSON and nothing else: {"ok": true}' }],
          model: resolvedModel,
        });
        return { data: generated.data, raw: generated.rawResponse, model: generated.model, provider: generated.provider };
      },
    });

    return { ok: true, provider, model, durationMs: Date.now() - startedAt };
  } catch (err) {
    if (err instanceof AIProviderUnavailableError) {
      return { ok: false, reason: "unavailable", message: "Configuration unavailable. Provider credentials are not configured on this environment." };
    }
    if (err instanceof AIProviderError) {
      return { ok: false, reason: "unavailable", message: "The selected model could not be reached." };
    }
    return { ok: false, reason: "unavailable", message: "The selected model could not be reached." };
  }
}
