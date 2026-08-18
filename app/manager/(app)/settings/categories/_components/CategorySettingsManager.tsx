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
import { flattenSpendCategoryPaths } from "@/app/manager/(app)/_components/ItemClassificationForms";

export function CategorySettingsManager({
  initialInventoryCategories,
  initialSpendCategories,
}: {
  initialInventoryCategories: CategorySummary[];
  initialSpendCategories: SpendCategorySummary[];
}) {
  const [inventoryCategories, setInventoryCategories] = useState(initialInventoryCategories);
  const [spendCategories, setSpendCategories] = useState(initialSpendCategories);

  return (
    <div className="mt-6 flex flex-col gap-8">
      <InventorySection categories={inventoryCategories} onReload={setInventoryCategories} />
      <SpendSection categories={spendCategories} onReload={setSpendCategories} />
    </div>
  );
}

function InventorySection({ categories, onReload }: { categories: CategorySummary[]; onReload: (c: CategorySummary[]) => void }) {
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function refresh() {
    const result = await listInventoryCategoriesFresh();
    if (result) onReload(result);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setPending(true);
    setError(null);
    const result = await createInventoryCategory(newName.trim());
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNewName("");
    await refresh();
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    const result = await renameInventoryCategory(id, editName.trim());
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditingId(null);
    await refresh();
  }

  async function handleToggleActive(category: CategorySummary) {
    const result = await setInventoryCategoryActive(category.id, !category.isActive);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Inventory Categories</h2>
      <div className="mt-3 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New category name"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        />
        <button type="button" onClick={handleCreate} disabled={pending || !newName.trim()} className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40">
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
      <div className="mt-3 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {categories.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No inventory categories yet.</p>
        ) : (
          categories.map((c) => (
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
          ))
        )}
      </div>
    </section>
  );
}

function SpendSection({ categories, onReload }: { categories: SpendCategorySummary[]; onReload: (c: SpendCategorySummary[]) => void }) {
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const activeForParentPicker = categories.filter((c) => c.isActive);
  const paths = flattenSpendCategoryPaths(categories);
  const pathById = new Map(paths.map((p) => [p.id, p.path]));

  async function refresh() {
    const result = await listSpendCategoriesFresh();
    if (result) onReload(result);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setPending(true);
    setError(null);
    const result = await createSpendCategory(newName.trim(), newParentId || null);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNewName("");
    setNewParentId("");
    await refresh();
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    const result = await renameSpendCategory(id, editName.trim());
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditingId(null);
    await refresh();
  }

  async function handleToggleActive(category: SpendCategorySummary) {
    const result = await setSpendCategoryActive(category.id, !category.isActive);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Spend Categories</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New category name"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        />
        <select value={newParentId} onChange={(e) => setNewParentId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100">
          <option value="">No parent (root category)</option>
          {activeForParentPicker.map((c) => (
            <option key={c.id} value={c.id}>
              {pathById.get(c.id)}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleCreate} disabled={pending || !newName.trim()} className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40">
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
      <div className="mt-3 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {paths.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No spend categories yet.</p>
        ) : (
          paths.map((p) => {
            const category = categories.find((c) => c.id === p.id)!;
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                {editingId === p.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                    autoFocus
                  />
                ) : (
                  <span className={`text-sm ${category.isActive ? "text-zinc-100" : "text-zinc-500 line-through"}`}>{p.path}</span>
                )}
                <div className="flex shrink-0 items-center gap-2">
                  {editingId === p.id ? (
                    <>
                      <button type="button" onClick={() => handleRename(p.id)} className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-zinc-950">
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
                        setEditingId(p.id);
                        setEditName(category.name);
                      }}
                      className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
                    >
                      Rename
                    </button>
                  )}
                  <button type="button" onClick={() => handleToggleActive(category)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
                    {category.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
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
