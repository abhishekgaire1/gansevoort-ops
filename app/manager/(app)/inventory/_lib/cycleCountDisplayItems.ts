/**
 * Framework-agnostic core for the Cycle Count counting screen's
 * auto-populated "Current Inventory" list. Pure/no I/O: every input here is
 * already-fetched, already-batched data (listInventoryBalancesForOrganization
 * and listActiveInventoryItemsForCycleCountAction, both single calls
 * regardless of item count -- never one request per item, satisfying the
 * "no N+1" requirement structurally: this module has no way to issue a
 * network request at all).
 *
 * KEY DISTINCTION this module exists to get right: a positive-balance item
 * appearing in the returned list is a LIVE, virtual row (lineId: null) --
 * displaying it never implies a cycle_count_line was created. Only an item
 * that already has a real line (explicitly counted, or explicitly added via
 * search) carries a non-null lineId and a FROZEN snapshot
 * (expectedQuantityAtSnapshot, captured whenever that line was actually
 * created -- never re-derived here). The caller (CycleCountView) is the one
 * that turns a virtual row into a real line, and only at the moment the
 * manager saves an actual physical observation for it.
 */

export interface InventoryBalanceRowLike {
  inventoryItemId: string;
  locationId: string;
  balance: number;
}

export interface SearchableItemLike {
  id: string;
  name: string;
  categoryName: string;
  baseUnitCode: string;
}

export interface CycleCountLineLike {
  id: string;
  inventoryItemId: string;
  itemName: string;
  categoryName: string;
  baseUnitCode: string;
  expectedQuantityAtSnapshot: string;
  physicalCountQuantity: string | null;
  /** Optional (not every caller/fixture needs to set these) -- defaults
   * to null/unresolved in the built CycleCountDisplayItem when omitted. */
  identifiedWasteQuantity?: string | null;
  wasteEventId?: string | null;
  wasteReasonCode?: string | null;
}

export interface CycleCountDisplayItem {
  inventoryItemId: string;
  /** null = a virtual row (positive balance, no line yet -- Part
   * "IMPORTANT: DISPLAYING IS NOT THE SAME AS COUNTING"). Non-null = a
   * real cycle_count_line, whose expectedQuantity below is that line's
   * OWN frozen snapshot, never a live re-read. */
  lineId: string | null;
  itemName: string;
  categoryName: string;
  baseUnitCode: string;
  expectedQuantity: string;
  physicalCountQuantity: string | null;
  /** Provisional "known waste found during counting" marker (Part 22/23)
   * -- always null for a virtual row (no line = nothing flagged yet). */
  identifiedWasteQuantity: string | null;
  /** Non-null once the identified waste has actually been posted (Phase
   * F) -- the checkbox/quantity become read-only display at that point,
   * never re-editable through this provisional-marking path again. */
  wasteEventId: string | null;
  wasteReasonCode: string | null;
}

/**
 * Merges (a) every item with a current POSITIVE balance at exactly
 * locationId (never a sibling location, never zero/negative) and (b) every
 * already-existing cycle_count_line for this count (resume-safe -- a
 * previously counted or previously added-but-blank item is preserved
 * verbatim, snapshot included, never re-derived from the current balance).
 * A line always wins over a same-item virtual row: once real, a line's
 * frozen snapshot is authoritative for display.
 *
 * Sorted by category then item name -- a sensible deterministic order,
 * never random or fetch-order-dependent.
 */
export function buildCycleCountDisplayItems(
  locationId: string,
  balances: InventoryBalanceRowLike[],
  searchableItems: SearchableItemLike[],
  lines: CycleCountLineLike[]
): CycleCountDisplayItem[] {
  const itemMetaById = new Map(searchableItems.map((item) => [item.id, item]));
  const byItemId = new Map<string, CycleCountDisplayItem>();

  for (const row of balances) {
    if (row.locationId !== locationId || row.balance <= 0) continue;
    const meta = itemMetaById.get(row.inventoryItemId);
    if (!meta) continue; // defensive: an inactive/unknown item never surfaces here
    byItemId.set(row.inventoryItemId, {
      inventoryItemId: row.inventoryItemId,
      lineId: null,
      itemName: meta.name,
      categoryName: meta.categoryName,
      baseUnitCode: meta.baseUnitCode,
      expectedQuantity: String(row.balance),
      physicalCountQuantity: null,
      identifiedWasteQuantity: null,
      wasteEventId: null,
      wasteReasonCode: null,
    });
  }

  for (const line of lines) {
    byItemId.set(line.inventoryItemId, {
      inventoryItemId: line.inventoryItemId,
      lineId: line.id,
      itemName: line.itemName,
      categoryName: line.categoryName,
      baseUnitCode: line.baseUnitCode,
      expectedQuantity: line.expectedQuantityAtSnapshot,
      physicalCountQuantity: line.physicalCountQuantity,
      identifiedWasteQuantity: line.identifiedWasteQuantity ?? null,
      wasteEventId: line.wasteEventId ?? null,
      wasteReasonCode: line.wasteReasonCode ?? null,
    });
  }

  return Array.from(byItemId.values()).sort((a, b) => {
    const categoryCompare = a.categoryName.localeCompare(b.categoryName);
    return categoryCompare !== 0 ? categoryCompare : a.itemName.localeCompare(b.itemName);
  });
}

/** Adjacent-run grouping over an already category-sorted list -- purely a
 * display convenience, never re-sorts. */
export function groupDisplayItemsByCategory(items: CycleCountDisplayItem[]): { categoryName: string; items: CycleCountDisplayItem[] }[] {
  const groups: { categoryName: string; items: CycleCountDisplayItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.categoryName === item.categoryName) {
      last.items.push(item);
    } else {
      groups.push({ categoryName: item.categoryName, items: [item] });
    }
  }
  return groups;
}

/** Search's purpose is finding an item the system does NOT currently
 * expect at this location (Part "SEARCH REMAINS IMPORTANT") -- excludes
 * anything already on screen (whether a real line or a live positive-
 * balance row), so a search result can never duplicate an already-visible
 * row. displayedItemIds should be every id currently returned by
 * buildCycleCountDisplayItems. */
export function filterSuggestedItems(searchableItems: SearchableItemLike[], displayedItemIds: Set<string>, query: string): SearchableItemLike[] {
  const trimmedQuery = query.trim().toLowerCase();
  const candidates = searchableItems.filter((item) => !displayedItemIds.has(item.id));
  const filtered = trimmedQuery === "" ? candidates : candidates.filter((item) => item.name.toLowerCase().includes(trimmedQuery));
  return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
}

/** The counted-item count shown to the manager (Part "PAGE STRUCTURE": "Do
 * NOT show '9 items counted' merely because 9 items are displayed") --
 * ONLY rows with an explicit physical observation, never virtual rows
 * (which structurally always carry physicalCountQuantity: null). */
export function countExplicitObservations(items: CycleCountDisplayItem[]): number {
  return items.filter((item) => item.physicalCountQuantity !== null).length;
}
