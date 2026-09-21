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
  updateInventoryCategoryDescription,
  updateSpendCategoryDescription,
  type CategorySummary,
  type SpendCategorySummary,
} from "@/app/actions/itemMaster";
import { primaryButtonClass } from "@/app/components/manager/buttonStyles";
import { StatusBadge } from "@/app/components/manager/StatusBadge";

type Tab = "inventory" | "spend";

/**
 * Admin -> Categories (Flat Category Architecture milestone) -- single
 * page, internal tabs -- never two sidebar entries. ONE LEVEL ONLY: no
 * Parent Category field, no Add Subcategory, no hierarchy anywhere.
 *
 * Both Inventory and Expense categories live here, each row labelled with
 * its Type. "Expense Categories" is the UI label -- the underlying table
 * is still spend_categories and the action names are unchanged; only
 * display text says "Expense".
 *
 * Each row shows its description and how many items / invoice lines use it.
 * No destructive deletion (a category ever referenced by an item or a
 * classification snapshot remains resolvable in history -- deactivate /
 * reactivate only).
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

      <p className="text-xs text-zinc-500">
        {tab === "inventory"
          ? "Inventory categories organize physical items whose quantities are tracked."
          : "Expense categories classify invoice lines that do not add inventory."}
      </p>

      {tab === "inventory" ? (
        <CategorySection
          kind="Inventory"
          categories={inventoryCategories}
          onReload={setInventoryCategories}
          createCategory={createInventoryCategory}
          renameCategory={renameInventoryCategory}
          setCategoryActive={setInventoryCategoryActive}
          updateDescription={updateInventoryCategoryDescription}
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
          updateDescription={updateSpendCategoryDescription}
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
  description?: string | null;
  usageCount?: number;
  requiresExplanation?: boolean;
}

/** Shared by both tabs -- Inventory and Expense categories are flat,
 * single-level lists with identical create/rename/activate/describe
 * shapes. Kept as one component with a `kind` label rather than two
 * near-duplicates. */
function CategorySection<T extends FlatCategory>({
  kind,
  categories,
  onReload,
  createCategory,
  renameCategory,
  setCategoryActive,
  updateDescription,
  refresh,
}: {
  kind: "Inventory" | "Expense";
  categories: T[];
  onReload: (c: T[]) => void;
  createCategory: (name: string) => Promise<{ ok: boolean; message?: string }>;
  renameCategory: (id: string, name: string) => Promise<{ ok: boolean; message?: string }>;
  setCategoryActive: (id: string, isActive: boolean) => Promise<{ ok: boolean; message?: string }>;
  updateDescription: (id: string, description: string) => Promise<{ ok: boolean; message?: string }>;
  refresh: () => Promise<T[] | null>;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [describingId, setDescribingId] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState("");

  const usageNoun = kind === "Inventory" ? "item" : "line";

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

  async function handleSaveDescription(id: string) {
    const result = await updateDescription(id, editDescription.trim());
    if (!result.ok) {
      setError(result.message ?? "Unable to save. Try again.");
      return;
    }
    setDescribingId(null);
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
              <div key={c.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {editingId === c.id ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                        autoFocus
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-sm ${c.isActive ? "text-zinc-100" : "text-zinc-500 line-through"}`}>{c.name}</span>
                        <StatusBadge label={kind === "Inventory" ? "Inventory" : "Expense"} tone="info" />
                        {c.requiresExplanation ? <StatusBadge label="Needs explanation" tone="warning" /> : null}
                        {!c.isActive ? <StatusBadge label="Inactive" tone="neutral" /> : null}
                      </div>
                    )}
                    {editingId !== c.id ? (
                      <p className="mt-1 text-xs text-zinc-500">
                        {c.description ? <span>{c.description} · </span> : null}
                        {typeof c.usageCount === "number" ? `${c.usageCount} ${usageNoun}${c.usageCount === 1 ? "" : "s"}` : ""}
                      </p>
                    ) : null}
                  </div>
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
                      <>
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
                        <button
                          type="button"
                          onClick={() => {
                            setDescribingId(describingId === c.id ? null : c.id);
                            setEditDescription(c.description ?? "");
                          }}
                          className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                        >
                          Description
                        </button>
                        <button type="button" onClick={() => handleToggleActive(c)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                          {c.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {describingId === c.id ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Short description of what belongs in this category"
                      className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => handleSaveDescription(c.id)} className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-zinc-950">
                        Save
                      </button>
                      <button type="button" onClick={() => setDescribingId(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
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
