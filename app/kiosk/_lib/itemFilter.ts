/**
 * Pure item-selection search/category logic, extracted out of KioskApp so
 * it's independently testable (this codebase has no component-rendering
 * test infrastructure -- see tests/*.unit.test.ts generally -- pure logic
 * modules are how screen behavior gets covered).
 *
 * Deliberately operates on nothing but {id, name, categoryId, categoryName}
 * -- see app/actions/inventoryItems.ts's KioskInventoryItem -- there is no
 * unit/package-related field anywhere on this type for item selection to
 * depend on, before or after the withdrawal-unit simplification.
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

export function filterItems(items: FilterableItem[], query: string, activeCategoryId: string | null): FilterableItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter((item) => {
    const matchesQuery = normalizedQuery === "" || item.name.toLowerCase().includes(normalizedQuery);
    const matchesCategory = activeCategoryId === null || item.categoryId === activeCategoryId;
    return matchesQuery && matchesCategory;
  });
}
