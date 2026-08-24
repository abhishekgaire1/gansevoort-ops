"use client";

import { useState } from "react";
import type { AIOrganizationConfiguration } from "@/app/lib/ai/admin";
import type { AIUsageReport } from "@/app/lib/ai/usage";
import { ConfigurationTab, type AIModelOption, type AIProviderOption } from "./ConfigurationTab";
import { UsageCostTab } from "./UsageCostTab";

type Tab = "configuration" | "usage";

export function AIConfigurationTabs({
  initialConfiguration,
  providers,
  models,
  initialUsageReport,
}: {
  initialConfiguration: AIOrganizationConfiguration;
  providers: AIProviderOption[];
  models: AIModelOption[];
  initialUsageReport: AIUsageReport;
}) {
  const [tab, setTab] = useState<Tab>("configuration");

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab("configuration")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "configuration" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Configuration
        </button>
        <button
          type="button"
          onClick={() => setTab("usage")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "usage" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Usage &amp; Cost
        </button>
      </div>

      {tab === "configuration" ? (
        <ConfigurationTab initialConfiguration={initialConfiguration} providers={providers} models={models} />
      ) : (
        <UsageCostTab initialReport={initialUsageReport} />
      )}
    </div>
  );
}
