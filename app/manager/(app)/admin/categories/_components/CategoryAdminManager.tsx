"use client";

import { useState } from "react";
import {
  listInventoryCategories,
  listSpendCategories,
  createInventoryCategory,
  createSpendCategory,
  renameInventoryCategory,
  setInventoryCategoryActive,
  renameSpendCategory,
  setSpendCategoryActive,
  type CategorySummary,
  type SpendCategorySummary,
} from "@/app/actions/itemMaster";
import { primaryButtonClass } from "@/app/components/manager/buttonStyles";

type Tab = "inventory" | "spend";

/**
 * Admin -> Categories (Flat Category Architecture milestone) -- single
 * page, internal tabs -- never two sidebar entries. ONE LEVEL ONLY: no
 * Parent Category field, no Add Subcategory, no hierarchy tree/indentation
 * anywhere in this UI. Categories remain organizationally flat forever
 * (Part 1-3) -- a future Reporting Group concept, if built, will be a
 * separate mechanism referencing category ids, never a revival of
 * parent/child editing here (Part 7/40).
 *
 * "Expense Categories" is the UI label (Part 3) -- the underlying table
 * is still spend_categories and the action names below are unchanged;
 * only display text says "Expense".
 *
 * No drag/drop, no destructive deletion (a category ever referenced by an
 * item or a classification snapshot remains resolvable in history --
 * deactivate/reactivate only).
 */
export function CategoryAdminManager({
  initialInventoryCategories,
  initialSpendCategories,
}: {
  initialInventoryCategories: CategorySummary[];
  initialSpendCategories: SpendCategorySummary[];
}) {
  const [tab, setTab] = useState<Tab>("inventory");
  const [inventoryCategories, setInventoryCategories] = useState(initialInventoryCategories);
  const [spendCategories, setSpendCategories] = useState(initialSpendCategories);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab("inventory")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "inventory" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Inventory Categories
        </button>
        <button
          type="button"
          onClick={() => setTab("spend")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "spend" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Expense Categories
        </button>
      </div>

      {tab === "inventory" ? (
        <CategorySection
          kind="Inventory"
          categories={inventoryCategories}
          onReload={setInventoryCategories}
          createCategory={createInventoryCategory}
          renameCategory={renameInventoryCategory}
          setCategoryActive={setInventoryCategoryActive}
          refresh={listInventoryCategoriesFresh}
        />
      ) : (
        <CategorySection
          kind="Expense"
          categories={spendCategories}
          onReload={setSpendCategories}
          createCategory={createSpendCategory}
          renameCategory={renameSpendCategory}
          setCategoryActive={setSpendCategoryActive}
          refresh={listSpendCategoriesFresh}
        />
      )}
    </div>
  );
}

interface FlatCategory {
  id: string;
  name: string;
  isActive?: boolean;
}

/** Shared by both tabs -- Inventory Categories and Expense Categories are
 * flat, single-level lists with identical create/rename/activate shapes
 * (Part 38's own mockup shows them presented the same way). Kept as one
 * component with a `kind` label rather than two near-duplicates. */
function CategorySection<T extends FlatCategory>({
  kind,
  categories,
  onReload,
  createCategory,
  renameCategory,
  setCategoryActive,
  refresh,
}: {
  kind: "Inventory" | "Expense";
  categories: T[];
  onReload: (c: T[]) => void;
  createCategory: (name: string) => Promise<{ ok: boolean; message?: string }>;
  renameCategory: (id: string, name: string) => Promise<{ ok: boolean; message?: string }>;
  setCategoryActive: (id: string, isActive: boolean) => Promise<{ ok: boolean; message?: string }>;
  refresh: () => Promise<T[] | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function reload() {
    const result = await refresh();
    if (result) onReload(result);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setPending(true);
    setError(null);
    const result = await createCategory(newName.trim());
    setPending(false);
    if (!result.ok) {
      setError(result.message ?? "Unable to save. Try again.");
      return;
    }
    setNewName("");
    setAdding(false);
    await reload();
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    const result = await renameCategory(id, editName.trim());
    if (!result.ok) {
      setError(result.message ?? "Unable to save. Try again.");
      return;
    }
    setEditingId(null);
    await reload();
  }

  async function handleToggleActive(category: T) {
    setError(null);
    const result = await setCategoryActive(category.id, !category.isActive);
    if (!result.ok) {
      setError(result.message ?? "Unable to save. Try again.");
      return;
    }
    await reload();
  }

  return (
    <section>
      {categories.length === 0 && !adding ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">No categories configured.</p>
          <button type="button" onClick={() => setAdding(true)} className={`mt-3 ${primaryButtonClass}`}>
            + Add Category
          </button>
        </div>
      ) : (
        <>
          {adding ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:flex-row sm:items-center">
              <label className="flex-1 text-xs text-zinc-400">
                Name *
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={kind === "Inventory" ? "e.g. Dairy" : "e.g. Repairs & Maintenance"}
                  autoFocus
                  className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                />
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={handleCreate} disabled={pending || !newName.trim()} className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40">
                  {pending ? "Adding…" : "Add Category"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewName("");
                    setError(null);
                  }}
                  className="text-sm text-zinc-500 hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className={primaryButtonClass}>
              + Add {kind} Category
            </button>
          )}
          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
          <div className="mt-3 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
            {categories.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                {editingId === c.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                    autoFocus
                  />
                ) : (
                  <span className={`text-sm ${c.isActive ? "text-zinc-100" : "text-zinc-500 line-through"}`}>{c.name}</span>
                )}
                <div className="flex shrink-0 items-center gap-2">
                  {editingId === c.id ? (
                    <>
                      <button type="button" onClick={() => handleRename(c.id)} className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-zinc-950">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditName(c.name);
                      }}
                      className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                    >
                      Rename
                    </button>
                  )}
                  <button type="button" onClick={() => handleToggleActive(c)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                    {c.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

async function listInventoryCategoriesFresh(): Promise<CategorySummary[] | null> {
  const result = await listInventoryCategories({ includeInactive: true });
  return result.ok ? result.categories : null;
}

async function listSpendCategoriesFresh(): Promise<SpendCategorySummary[] | null> {
  const result = await listSpendCategories({ includeInactive: true });
  return result.ok ? result.categories : null;
}
