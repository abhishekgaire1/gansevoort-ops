/**
 * Pure fullness/visualization helpers for the inventory page's tank-style
 * stock gauges. Deliberately NOT "server-only" -- shared by the client
 * card components and unit-testable in isolation. Percentage is the main
 * numerical truth; color and label are derived presentation only.
 *
 * Thresholds (per the 2A.4 spec, reported before hardcoding):
 *   100%+  -> Full      (green)
 *   75-99% -> Healthy   (green)
 *   35-74% -> Medium    (yellow)
 *   1-34%  -> Low       (orange)
 *   0%     -> Empty     (red)
 * "Over Full" (current > reference) keeps the gauge visually capped at
 * 100% but never hides the real percentage/overage.
 */

export type StockLevel = "FULL" | "HEALTHY" | "MEDIUM" | "LOW" | "EMPTY";

export interface StockGauge {
  /** Real percentage (may exceed 100), rounded to one decimal. Null when
   * there is no reference to measure against. */
  percent: number | null;
  /** Gauge fill height, clamped to 0-100. 0 when percent is null. */
  fillPercent: number;
  level: StockLevel | null;
  label: string;
  overFull: boolean;
}

export function computeStockGauge(balance: number, fullReference: number | null): StockGauge {
  if (fullReference === null || fullReference <= 0) {
    return { percent: null, fillPercent: 0, level: null, label: balance > 0 ? "No reference set" : "No stock received yet", overFull: false };
  }

  const rawPercent = (balance / fullReference) * 100;
  const percent = Math.round(rawPercent * 10) / 10;
  const fillPercent = Math.min(100, Math.max(0, percent));
  const overFull = percent > 100;

  let level: StockLevel;
  if (percent <= 0) level = "EMPTY";
  else if (percent < 35) level = "LOW";
  else if (percent < 75) level = "MEDIUM";
  else if (percent < 100) level = "HEALTHY";
  else level = "FULL";

  const label = overFull ? "Over Full" : STOCK_LEVEL_LABEL[level];
  return { percent, fillPercent, level, label, overFull };
}

export const STOCK_LEVEL_LABEL: Record<StockLevel, string> = {
  FULL: "Full",
  HEALTHY: "Healthy",
  MEDIUM: "Medium",
  LOW: "Low",
  EMPTY: "Empty",
};

/** Tailwind classes for the gauge fill -- natural progression, but color
 * is never the only signal (fill height + numeric percentage always
 * accompany it). */
export function stockLevelFillClass(level: StockLevel | null): string {
  switch (level) {
    case "FULL":
    case "HEALTHY":
      return "bg-emerald-500";
    case "MEDIUM":
      return "bg-yellow-500";
    case "LOW":
      return "bg-orange-500";
    case "EMPTY":
      return "bg-red-500";
    default:
      return "bg-zinc-700";
  }
}

export function stockLevelTextClass(level: StockLevel | null): string {
  switch (level) {
    case "FULL":
    case "HEALTHY":
      return "text-emerald-400";
    case "MEDIUM":
      return "text-yellow-400";
    case "LOW":
      return "text-orange-400";
    case "EMPTY":
      return "text-red-400";
    default:
      return "text-zinc-500";
  }
}
