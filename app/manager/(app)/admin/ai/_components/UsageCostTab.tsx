"use client";

import { useEffect, useRef, useState } from "react";
import { getAIUsageReportAction, type AIUsagePeriodKind } from "@/app/actions/adminAIUsage";
import type { AIUsageReport } from "@/app/lib/ai/usage";
import { AI_USAGE_TASK_LABELS, type AIUsageTaskKey } from "@/app/lib/ai/taskKeys";
import { AI_PROVIDERS, findModel } from "@/app/lib/ai/models";
import { formatEstimatedCost, formatTokenCount } from "@/app/lib/format/currency";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const PERIOD_LABELS: Record<AIUsagePeriodKind, string> = {
  TODAY: "Today",
  THIS_WEEK: "This Week",
  THIS_MONTH: "This Month",
  CUSTOM: "Custom",
};

function taskLabel(taskKey: string): string {
  return AI_USAGE_TASK_LABELS[taskKey as AIUsageTaskKey] ?? taskKey;
}

function providerLabel(provider: string): string {
  return AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS]?.displayName ?? provider;
}

function modelLabel(provider: string, model: string): string {
  return findModel(provider, model)?.displayName ?? model;
}

function todayLocalDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function UsageCostTab({ initialReport }: { initialReport: AIUsageReport }) {
  const [period, setPeriod] = useState<AIUsagePeriodKind>("TODAY");
  const [customStart, setCustomStart] = useState(todayLocalDateString());
  const [customEnd, setCustomEnd] = useState(todayLocalDateString());
  const [report, setReport] = useState<AIUsageReport | null>(initialReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [applyTrigger, setApplyTrigger] = useState(0);
  // The initial render already has TODAY's report from the server (the
  // default period) -- this effect exists only to re-fetch after a
  // genuine period/date change, matching the established convention
  // (see AdminItemsView.tsx's own isFirstRender guard for the same
  // "server already fetched the initial state" reasoning).
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAIUsageReportAction(period, period === "CUSTOM" ? customStart : undefined, period === "CUSTOM" ? customEnd : undefined).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("message" in result ? result.message : "Unable to load AI usage.");
        return;
      }
      setReport(result.report);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, applyTrigger]);

  const summary = report?.summary ?? null;
  const hasEvents = (summary?.totalRequests ?? 0) > 0;
  const allCostUnknown = hasEvents && summary!.unknownCostRequestCount === summary!.totalRequests;
  const someCostUnknown = hasEvents && summary!.unknownCostRequestCount > 0 && !allCostUnknown;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-zinc-500">Track AI API usage across Gansevoort Ops.</p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1">
          {(["TODAY", "THIS_WEEK", "THIS_MONTH", "CUSTOM"] as AIUsagePeriodKind[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${period === p ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {period === "CUSTOM" ? (
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Start Date
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              End Date
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <button type="button" onClick={() => setApplyTrigger((n) => n + 1)} className={secondaryButtonClass}>
              Apply
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => setApplyTrigger((n) => n + 1)} className={`mt-3 ${secondaryButtonClass}`}>
            Try Again
          </button>
        </div>
      ) : loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !hasEvents ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">No AI usage recorded for this period.</p>
          <p className="mt-2 text-sm text-zinc-400">
            Estimated Cost <span className="font-semibold text-zinc-200">$0.00</span>
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard
              label="Estimated Cost"
              value={allCostUnknown ? "Cost unavailable" : formatEstimatedCost(summary!.totalCostUsd)}
              note={someCostUnknown ? `Unavailable for ${summary!.unknownCostRequestCount} request${summary!.unknownCostRequestCount === 1 ? "" : "s"}` : allCostUnknown ? "Pricing not configured for these models" : null}
            />
            <SummaryCard label="Requests" value={String(summary!.totalRequests)} note={`${summary!.successRequests} successful · ${summary!.failedRequests} failed`} />
            {summary!.inputTokens > 0 ? <SummaryCard label="Input Tokens" value={formatTokenCount(summary!.inputTokens)} /> : null}
            {summary!.outputTokens > 0 ? <SummaryCard label="Output Tokens" value={formatTokenCount(summary!.outputTokens)} /> : null}
          </div>

          <BreakdownSection
            title="Cost by Task"
            rows={report!.byTask.map((r) => ({ key: r.taskKey, label: taskLabel(r.taskKey), costUsd: r.costUsd, unknownCount: r.unknownCostRequestCount, requestCount: r.requestCount }))}
          />

          <BreakdownSection
            title="Cost by Model"
            rows={report!.byModel.map((r) => ({ key: `${r.provider}::${r.model}`, label: modelLabel(r.provider, r.model), costUsd: r.costUsd, unknownCount: r.unknownCostRequestCount, requestCount: r.requestCount }))}
          />

          {report!.byProvider.length > 1 ? (
            <BreakdownSection
              title="Cost by Provider"
              rows={report!.byProvider.map((r) => ({ key: r.provider, label: providerLabel(r.provider), costUsd: r.costUsd, unknownCount: r.unknownCostRequestCount, requestCount: r.requestCount }))}
            />
          ) : null}

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Requests</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500">
                    <th className="pb-2 pr-3 font-medium">Time</th>
                    <th className="pb-2 pr-3 font-medium">Task</th>
                    <th className="pb-2 pr-3 font-medium">Model</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {report!.recent.map((row) => (
                    <tr key={row.eventId}>
                      <td className="py-2 pr-3 text-zinc-400">{new Date(row.occurredAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                      <td className="py-2 pr-3 text-zinc-200">{taskLabel(row.taskKey)}</td>
                      <td className="py-2 pr-3 text-zinc-400">{modelLabel(row.provider, row.model)}</td>
                      <td className="py-2 pr-3">
                        <span className={row.status === "SUCCESS" ? "text-emerald-400" : "text-red-400"}>{row.status === "SUCCESS" ? "Success" : "Failed"}</span>
                      </td>
                      <td className="py-2 text-zinc-200">{row.costKnown ? formatEstimatedCost(row.costUsd!) : "unavailable"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
      {note ? <p className="mt-0.5 text-xs text-zinc-500">{note}</p> : null}
    </div>
  );
}

function BreakdownSection({ title, rows }: { title: string; rows: { key: string; label: string; costUsd: number; unknownCount: number; requestCount: number }[] }) {
  if (rows.length === 0) return null;
  const totalKnown = rows.reduce((sum, r) => sum + r.costUsd, 0);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      <div className="mt-3 flex flex-col divide-y divide-zinc-800">
        {rows.map((row) => {
          const allUnknown = row.unknownCount === row.requestCount;
          const pct = totalKnown > 0 ? (row.costUsd / totalKnown) * 100 : 0;
          return (
            <div key={row.key} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-zinc-200">{row.label}</span>
              <span className="flex items-center gap-2">
                {row.unknownCount > 0 ? <span className="text-xs text-zinc-600">{row.unknownCount} unpriced</span> : null}
                <span className="text-zinc-400">{allUnknown ? "unavailable" : formatEstimatedCost(row.costUsd)}</span>
                {!allUnknown && totalKnown > 0 ? <span className="w-12 text-right text-xs text-zinc-600">{pct.toFixed(1)}%</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
