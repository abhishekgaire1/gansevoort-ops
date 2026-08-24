"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAIDefaultConfigurationAction, saveAITaskConfigurationAction, testAIConfigurationAction } from "@/app/actions/adminAI";
import type { AIOrganizationConfiguration } from "@/app/lib/ai/admin";
import { CONFIGURABLE_AI_TASK_KEYS, AI_TASK_LABELS, AI_TASK_DESCRIPTIONS } from "@/app/lib/ai/taskKeys";
import { isModelCompatibleWithTask } from "@/app/lib/ai/models";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

export interface AIProviderOption {
  key: string;
  displayName: string;
  connected: boolean;
}

export interface AIModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  recommendedFor: string[];
}

interface TaskSelection {
  mode: "default" | "specific";
  provider: string;
  model: string;
}

function selectionsFromConfiguration(configuration: AIOrganizationConfiguration): Record<string, TaskSelection> {
  const result: Record<string, TaskSelection> = {};
  for (const t of configuration.tasks) {
    result[t.task] = t.override ? { mode: "specific", provider: t.override.provider, model: t.override.model } : { mode: "default", provider: t.effective.provider, model: t.effective.model };
  }
  return result;
}

export function ConfigurationTab({
  initialConfiguration,
  providers,
  models,
}: {
  initialConfiguration: AIOrganizationConfiguration;
  providers: AIProviderOption[];
  models: AIModelOption[];
}) {
  const router = useRouter();
  const [defaultProvider, setDefaultProvider] = useState(initialConfiguration.effectiveDefault.provider);
  const [defaultModel, setDefaultModel] = useState(initialConfiguration.effectiveDefault.model);
  const [taskSelections, setTaskSelections] = useState<Record<string, TaskSelection>>(() => selectionsFromConfiguration(initialConfiguration));

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true; provider: string; model: string; durationMs: number } | { ok: false; message: string } | null>(null);

  const modelsForProvider = models.filter((m) => m.provider === defaultProvider);
  const connectedProviders = new Map(providers.map((p) => [p.key, p.connected]));
  const defaultConnected = connectedProviders.get(defaultProvider) ?? false;

  const defaultDirty = defaultProvider !== initialConfiguration.effectiveDefault.provider || defaultModel !== initialConfiguration.effectiveDefault.model;
  const dirtyTasks = CONFIGURABLE_AI_TASK_KEYS.filter((task) => {
    const current = taskSelections[task];
    const original = initialConfiguration.tasks.find((t) => t.task === task);
    if (!current || !original) return false;
    if (current.mode === "default") return original.override !== null;
    return original.override === null || original.override.provider !== current.provider || original.override.model !== current.model;
  });
  const isDirty = defaultDirty || dirtyTasks.length > 0;

  async function handleTest() {
    setTestPending(true);
    setTestResult(null);
    const result = await testAIConfigurationAction(defaultProvider, defaultModel);
    setTestPending(false);
    setTestResult(result.ok ? { ok: true, provider: result.provider, model: result.model, durationMs: result.durationMs } : { ok: false, message: "message" in result ? result.message : "Unable to reach the selected model." });
  }

  async function handleSave() {
    if (saving || !isDirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    if (defaultDirty) {
      const result = await saveAIDefaultConfigurationAction(defaultProvider, defaultModel);
      if (!result.ok) {
        setSaving(false);
        setSaveError("message" in result ? result.message : "Unable to save AI configuration.");
        return;
      }
    }

    for (const task of dirtyTasks) {
      const selection = taskSelections[task];
      const result = await saveAITaskConfigurationAction(task, selection.mode === "specific" ? selection.provider : null, selection.mode === "specific" ? selection.model : null);
      if (!result.ok) {
        setSaving(false);
        setSaveError("message" in result ? result.message : "Unable to save AI configuration.");
        return;
      }
    }

    setSaving(false);
    setSaveSuccess("AI configuration saved.");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Default AI</p>

        <div className="mt-3 flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Provider
            <select
              value={defaultProvider}
              onChange={(e) => {
                setDefaultProvider(e.target.value);
                const firstModel = models.find((m) => m.provider === e.target.value);
                if (firstModel) setDefaultModel(firstModel.modelId);
                setTestResult(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            >
              {providers.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Default Model
            <select
              value={defaultModel}
              onChange={(e) => {
                setDefaultModel(e.target.value);
                setTestResult(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            >
              {modelsForProvider.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.displayName}
                  {m.recommendedFor.length > 0 ? ` (${m.recommendedFor.join(", ")})` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            Status
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span className={`h-2 w-2 rounded-full ${defaultConnected ? "bg-emerald-400" : "bg-zinc-600"}`} />
              <span className={defaultConnected ? "text-emerald-300" : "text-zinc-500"}>{defaultConnected ? "Available" : "Configuration unavailable"}</span>
            </div>
          </div>
        </div>

        <div className="mt-3">
          <button type="button" disabled={testPending || !defaultConnected} onClick={handleTest} className={secondaryButtonClass}>
            {testPending ? "Testing…" : "Test Configuration"}
          </button>
          {testResult ? (
            testResult.ok ? (
              <div className="mt-2 rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3 text-sm">
                <p className="font-semibold text-emerald-300">Configuration Working</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Provider: <span className="text-zinc-200">{providers.find((p) => p.key === testResult.provider)?.displayName ?? testResult.provider}</span>
                </p>
                <p className="text-xs text-zinc-400">
                  Model: <span className="text-zinc-200">{testResult.model}</span>
                </p>
                <p className="text-xs text-zinc-400">
                  Response Time: <span className="text-zinc-200">{testResult.durationMs} ms</span>
                </p>
              </div>
            ) : (
              <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/20 p-3 text-sm">
                <p className="font-semibold text-red-300">Configuration Unavailable</p>
                <p className="mt-1 text-xs text-zinc-400">{testResult.message}</p>
              </div>
            )
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Task Models</p>
        <div className="mt-3 flex flex-col divide-y divide-zinc-800">
          {CONFIGURABLE_AI_TASK_KEYS.map((task) => {
            const selection = taskSelections[task];
            const compatibleModels = models.filter((m) => isModelCompatibleWithTask(m.provider, m.modelId, task));
            return (
              <div key={task} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">{AI_TASK_LABELS[task]}</p>
                  <p className="mt-0.5 max-w-md text-xs text-zinc-500">{AI_TASK_DESCRIPTIONS[task]}</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={selection.mode === "default" ? "__default__" : `${selection.provider}::${selection.model}`}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTaskSelections((prev) => ({
                        ...prev,
                        [task]: value === "__default__" ? { mode: "default", provider: defaultProvider, model: defaultModel } : { mode: "specific", provider: value.split("::")[0], model: value.split("::")[1] },
                      }));
                    }}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
                  >
                    <option value="__default__">Use Default ({models.find((m) => m.provider === defaultProvider && m.modelId === defaultModel)?.displayName ?? defaultModel})</option>
                    {compatibleModels.map((m) => (
                      <option key={m.modelId} value={`${m.provider}::${m.modelId}`}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
          <div className="pt-3 text-xs text-zinc-500">AI Chatbot — Not configured yet</div>
        </div>
      </section>

      {saveError ? <p className="text-sm text-red-400">{saveError}</p> : null}
      {saveSuccess && !isDirty ? <p className="text-sm text-emerald-400">{saveSuccess}</p> : null}

      <div>
        <button type="button" disabled={saving || !isDirty} onClick={handleSave} className={`${primaryButtonClass} disabled:opacity-40`}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
