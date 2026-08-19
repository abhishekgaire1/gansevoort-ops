/**
 * Pure item-selection category logic, extracted out of KioskApp so it's
 * independently testable (this codebase has no component-rendering test
 * infrastructure -- see tests/*.unit.test.ts generally -- pure logic
 * modules are how screen behavior gets covered).
 *
 * Depends on nothing but {id, name, categoryId, categoryName} -- generic
 * over the caller's actual item type (KioskInventoryItem, see
 * app/actions/inventoryItems.ts, carries additional 2A.5 availability
 * fields this module never needs) so filtering never drops those extra
 * fields on the way through.
 *
 * Query-text matching is NOT this module's job (Milestone 2A.5 Part D
 * replaced the naive substring match here with ranked smart/fuzzy search
 * -- see app/kiosk/_lib/search.ts). Category filtering and search ranking
 * compose in KioskApp: category filter narrows the candidate set first,
 * then search.ts ranks within it.
 */

export interface FilterableItem {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
}

export interface ItemCategory {
  id: string;
  name: string;
}

export function deriveItemCategories(items: FilterableItem[]): ItemCategory[] {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(item.categoryId, item.categoryName);
  }
  return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
}

export function filterItemsByCategory<T extends FilterableItem>(items: T[], activeCategoryId: string | null): T[] {
  return activeCategoryId === null ? items : items.filter((item) => item.categoryId === activeCategoryId);
}
