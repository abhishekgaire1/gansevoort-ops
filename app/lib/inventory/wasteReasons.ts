/**
 * Waste reason constants (Part 13) -- deliberately in their own
 * client-safe module, no "server-only" transitive dependency. waste.ts
 * (the RPC wrapper layer) has a server-only dependency chain
 * (cycleCounts.ts -> "server-only", listInventoryBalances.ts ->
 * "server-only"), so a "use client" component importing runtime values
 * from waste.ts directly would pull that whole chain into the client
 * bundle and fail the build. Types from waste.ts remain safe to import
 * (import type is erased at compile time), but these are runtime
 * values, so they live here instead.
 */
export const WASTE_REASON_CODES = ["EXPIRED", "SPOILED", "DAMAGED", "CONTAMINATED", "STORAGE_ISSUE", "OTHER"] as const;
export type WasteReasonCode = (typeof WASTE_REASON_CODES)[number];

export const WASTE_REASON_LABELS: Record<WasteReasonCode, string> = {
  EXPIRED: "Expired",
  SPOILED: "Spoiled",
  DAMAGED: "Damaged",
  CONTAMINATED: "Contaminated",
  STORAGE_ISSUE: "Storage Issue",
  OTHER: "Other",
};
