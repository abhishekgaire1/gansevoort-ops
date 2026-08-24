"use client";

import { useMemo, useState } from "react";
import { getInventoryItemUsageAction, type InventoryItemUsageData } from "@/app/actions/inventoryItemActivity";
import { USAGE_PERIODS, type UsagePeriod, type CustomUsageRange } from "@/app/lib/inventory/usagePeriods";
import { secondaryButtonClass, primaryButtonClass } from "@/app/components/manager/buttonStyles";
import { formatQuantityMagnitude } from "../../../_lib/activityPresentation";
import {
  USAGE_PERIOD_LABEL,
  todayDateStringInTimezone,
  usagePeriodDateSequence,
  dateSequenceBetween,
  daysBetweenInclusive,
  zeroFillUsageTrend,
  formatTrendPointLabel,
} from "../../../_lib/usagePresentation";

/**
 * Item Detail's Usage tab (Inventory Item Detail Overview + Usage
 * milestone) -- "where has this item been withdrawn," never "consumed"
 * or "sold" (Part 1: the trusted metric is WITHDRAWN TO STATION). No
 * chart library exists in this project and adding one solely for this
 * feature was judged out of scope (Part 17) -- station share and the
 * trend both use plain CSS width/height bars, the same simple technique
 * the existing stock gauge already uses elsewhere in this app, never a
 * hand-rolled SVG chart. The numbers are always shown alongside every
 * bar (Part 18) -- the chart supports comprehension, it is never the
 * only source of truth.
 *
 * Custom reuses the exact same Date From/To <input type="date"> pattern
 * the Global Inventory Activity page's filters already use -- no new
 * date-picker component, just presented as a small popover beneath the
 * "Custom" segmented-control button rather than inline fields. Opening
 * it defaults BOTH From and To to today (a valid, immediately-appliable
 * range) rather than two empty inputs. Nothing fetches until Apply, so
 * an incomplete/mid-typing selection never fires a request; Cancel (or
 * clicking outside) discards the in-progress edit and leaves whatever
 * was last applied untouched.
 */

const MAX_TREND_DAYS = 60;

export function UsageTab({
  itemId,
  locationId,
  locationTimezone,
  initialPeriod,
  initialUsage,
}: {
  itemId: string;
  locationId: string;
  locationTimezone: string;
  initialPeriod: UsagePeriod;
  initialUsage: InventoryItemUsageData;
}) {
  const [period, setPeriod] = useState<UsagePeriod>(initialPeriod);
  const [usage, setUsage] = useState<InventoryItemUsageData>(initialUsage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);
  const todayDateString = useMemo(() => todayDateStringInTimezone(now, locationTimezone), [now, locationTimezone]);

  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [customStartInput, setCustomStartInput] = useState("");
  const [customEndInput, setCustomEndInput] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [appliedCustomRange, setAppliedCustomRange] = useState<CustomUsageRange | null>(null);

  async function fetchUsage(nextPeriod: UsagePeriod, customRange?: CustomUsageRange | null): Promise<boolean> {
    setLoading(true);
    setError(null);
    const result = await getInventoryItemUsageAction(itemId, locationId, nextPeriod, customRange);
    setLoading(false);
    if (!result.ok) {
      const message = result.reason === "invalid_range" ? result.message : "Unable to load usage.";
      if (nextPeriod === "CUSTOM") {
        setCustomError(message);
      } else {
        setError(message);
      }
      return false;
    }
    setUsage(result.usage);
    return true;
  }

  async function handlePeriodChange(next: Exclude<UsagePeriod, "CUSTOM">) {
    if (loading) return;
    setCustomPickerOpen(false);
    if (next === period) return;
    setPeriod(next);
    await fetchUsage(next);
  }

  function openCustomPicker() {
    if (loading) return;
    setCustomStartInput(appliedCustomRange?.start ?? todayDateString);
    setCustomEndInput(appliedCustomRange?.end ?? todayDateString);
    setCustomError(null);
    setCustomPickerOpen(true);
  }

  function closeCustomPicker() {
    setCustomPickerOpen(false);
    setCustomError(null);
  }

  async function handleApplyCustom() {
    if (loading) return;
    if (!customStartInput || !customEndInput) {
      setCustomError("Choose a start and end date.");
      return;
    }
    if (customStartInput > customEndInput) {
      setCustomError("The start date must be on or before the end date.");
      return;
    }
    const range: CustomUsageRange = { start: customStartInput, end: customEndInput };
    setPeriod("CUSTOM");
    setAppliedCustomRange(range);
    const succeeded = await fetchUsage("CUSTOM", range);
    if (succeeded) setCustomPickerOpen(false);
  }

  const filledTrend = useMemo(() => {
    if (period === "TODAY") return [];
    if (period === "CUSTOM") {
      if (!appliedCustomRange) return [];
      return zeroFillUsageTrend(usage.trend, dateSequenceBetween(appliedCustomRange.start, appliedCustomRange.end));
    }
    return zeroFillUsageTrend(usage.trend, usagePeriodDateSequence(period, todayDateString));
  }, [usage.trend, period, todayDateString, appliedCustomRange]);

  const trendDayCount = period === "CUSTOM" && appliedCustomRange ? daysBetweenInclusive(appliedCustomRange.start, appliedCustomRange.end) : filledTrend.length;
  const trendTooLong = period === "CUSTOM" && trendDayCount > MAX_TREND_DAYS;

  const readyToShowResults = period !== "CUSTOM" || appliedCustomRange !== null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-zinc-500">See how this item is being withdrawn across stations.</p>

      <div className="relative self-start">
        <div className="relative z-20 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
          {USAGE_PERIODS.map((option) =>
            option === "CUSTOM" ? (
              <button
                key={option}
                type="button"
                onClick={() => (customPickerOpen ? closeCustomPicker() : openCustomPicker())}
                aria-pressed={period === "CUSTOM"}
                aria-expanded={customPickerOpen}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  period === "CUSTOM" || customPickerOpen ? "bg-amber-400/15 text-amber-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {period === "CUSTOM" && appliedCustomRange
                  ? appliedCustomRange.start === appliedCustomRange.end
                    ? appliedCustomRange.start
                    : `${appliedCustomRange.start} – ${appliedCustomRange.end}`
                  : USAGE_PERIOD_LABEL.CUSTOM}
              </button>
            ) : (
              <button
                key={option}
                type="button"
                onClick={() => handlePeriodChange(option)}
                aria-pressed={period === option}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  period === option ? "bg-amber-400/15 text-amber-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {USAGE_PERIOD_LABEL[option]}
              </button>
            )
          )}
        </div>

        {customPickerOpen ? (
          <>
            <button type="button" aria-label="Close date picker" onClick={closeCustomPicker} className="fixed inset-0 z-10 cursor-default" />
            <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl border border-zinc-700 bg-zinc-900 p-4 shadow-lg">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Custom Range</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                  From
                  <input
                    type="date"
                    value={customStartInput}
                    onChange={(e) => setCustomStartInput(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                  To
                  <input
                    type="date"
                    value={customEndInput}
                    onChange={(e) => setCustomEndInput(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
                  />
                </label>
              </div>
              {customError ? <p className="mt-2 text-xs text-red-400">{customError}</p> : null}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={closeCustomPicker} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" onClick={handleApplyCustom} disabled={loading} className={primaryButtonClass}>
                  {loading ? "Applying…" : "Apply"}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
          {period !== "CUSTOM" ? (
            <button type="button" onClick={() => fetchUsage(period)} className={`mt-2 ${secondaryButtonClass}`}>
              Try Again
            </button>
          ) : null}
        </div>
      ) : loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !readyToShowResults ? null : (
        <>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Total Withdrawn</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-100">
              {formatQuantityMagnitude(usage.byStation.total)} {usage.byStation.baseUnitCode}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Usage by Station</p>
            {usage.byStation.byStation.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">No station withdrawals for this period.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {usage.byStation.byStation.map((station) => (
                  <StationBar key={station.stationId} name={station.stationName} quantity={station.quantity} percentage={station.percentage} unit={usage.byStation.baseUnitCode} />
                ))}
              </div>
            )}
          </div>

          {period !== "TODAY" ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Usage Trend</p>
              {usage.byStation.total === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">No station withdrawals for this period.</p>
              ) : trendTooLong ? (
                <p className="mt-3 text-sm text-zinc-500">Trend is only shown for ranges of {MAX_TREND_DAYS} days or fewer.</p>
              ) : (
                <UsageTrendChart points={filledTrend} period={period} />
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function StationBar({ name, quantity, percentage, unit }: { name: string; quantity: number; percentage: number; unit: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-sm text-zinc-300" title={name}>
        {name}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div className="absolute inset-y-0 left-0 rounded-full bg-amber-400" style={{ width: `${Math.min(100, percentage)}%` }} />
      </div>
      <span className="w-20 shrink-0 text-right text-sm text-zinc-200">
        {formatQuantityMagnitude(quantity)} {unit}
      </span>
      <span className="w-12 shrink-0 text-right text-xs text-zinc-500">{percentage.toFixed(1)}%</span>
    </div>
  );
}

function UsageTrendChart({ points, period }: { points: { date: string; quantity: number }[]; period: "SEVEN_DAYS" | "THIRTY_DAYS" | "CUSTOM" }) {
  const max = Math.max(...points.map((p) => p.quantity), 1);
  const showLabels = period === "SEVEN_DAYS";

  return (
    <div className="mt-3">
      {!showLabels ? (
        <p className="mb-2 text-xs text-zinc-600">
          {points[0]?.date} – {points[points.length - 1]?.date}
        </p>
      ) : null}
      <div className="flex h-24 items-end gap-1">
        {points.map((point) => (
          <div key={point.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${point.date}: ${formatQuantityMagnitude(point.quantity)}`}>
            <div className="relative w-full flex-1 overflow-hidden rounded-t bg-zinc-800">
              <div className="absolute inset-x-0 bottom-0 rounded-t bg-amber-400/70" style={{ height: `${(point.quantity / max) * 100}%` }} />
            </div>
            {showLabels ? <span className="text-[10px] text-zinc-500">{formatTrendPointLabel(point.date, period)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
