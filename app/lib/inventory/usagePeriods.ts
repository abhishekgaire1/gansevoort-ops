/**
 * Usage period constants (Inventory Item Detail Overview + Usage
 * milestone) -- client-safe, no "server-only" dependency, same reasoning
 * as activityTypeFilters.ts: itemUsage.ts is server-only, so a "use
 * client" component needs this runtime value from a neutral module.
 */
export const USAGE_PERIODS = ["TODAY", "SEVEN_DAYS", "THIRTY_DAYS", "CUSTOM"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** An inclusive YYYY-MM-DD range, only meaningful when period === "CUSTOM". */
export interface CustomUsageRange {
  start: string;
  end: string;
}
