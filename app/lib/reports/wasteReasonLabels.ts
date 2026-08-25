/** Waste reason display labels -- single source shared by the Waste
 * report page and its export builder (previously duplicated only in the
 * page component). No new business logic; these are the same reason
 * codes record_inventory_waste already accepts. */
export const WASTE_REASON_LABEL: Record<string, string> = {
  EXPIRED: "Expired",
  SPOILED: "Spoiled",
  DAMAGED: "Damaged",
  CONTAMINATED: "Contaminated",
  STORAGE_ISSUE: "Storage Issue",
  OTHER: "Other",
};
