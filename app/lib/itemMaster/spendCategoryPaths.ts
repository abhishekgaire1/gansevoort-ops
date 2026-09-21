export interface SpendCategoryPathInput {
  id: string;
  name: string;
  parentId: string | null;
  /** Catch-all expense categories require a written explanation on every
   * line classified to them. Optional so existing callers stay valid. */
  requiresExplanation?: boolean;
}

export interface SpendCategoryPath {
  id: string;
  path: string;
  requiresExplanation: boolean;
}

/** Framework-free (no "use client"/"use server") so both the manager UI's
 * spend-category picker and the server-side AI classification candidate
 * builder flatten the identical arbitrary-depth hierarchy into "Root >
 * Child" paths, rather than maintaining two copies of this logic that could
 * silently drift apart. */
export function flattenSpendCategoryPaths(categories: SpendCategoryPathInput[]): SpendCategoryPath[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  function pathFor(c: SpendCategoryPathInput): string {
    const parent = c.parentId ? byId.get(c.parentId) : null;
    return parent ? `${pathFor(parent)} > ${c.name}` : c.name;
  }
  return categories.map((c) => ({ id: c.id, path: pathFor(c), requiresExplanation: c.requiresExplanation ?? false })).sort((a, b) => a.path.localeCompare(b.path));
}
