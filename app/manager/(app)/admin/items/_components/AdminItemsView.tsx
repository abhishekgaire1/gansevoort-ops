"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listAdminItemsAction } from "@/app/actions/adminItems";
import type { AdminItemSummary, ItemStatus } from "@/app/lib/admin/items";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Admin -> Item Master list (Part 8) -- compact, scannable rows, no
 * analytics/charts. Filters re-fetch through the server action, same
 * debounced-search convention as Admin Users / Global Inventory Activity.
 */
export function AdminItemsView({
  initialItems,
  categories,
  units,
}: {
  initialItems: AdminItemSummary[];
  categories: CategorySummary[];
  units: { id: string; code: string; name: string }[];
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [baseUnitCode, setBaseUnitCode] = useState("");
  const [status, setStatus] = useState<ItemStatus | "ALL">("active");
  const [items, setItems] = useState<AdminItemSummary[]>(initialItems);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAdminItemsAction(search.trim() || null, categoryId || null, baseUnitCode || null, status === "ALL" ? null : status).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("Unable to load items.");
        return;
      }
      setItems(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [search, categoryId, baseUnitCode, status]);

  const hasActiveFilters = search.trim() !== "" || categoryId !== "" || baseUnitCode !== "" || status !== "active";

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setCategoryId("");
    setBaseUnitCode("");
    setStatus("active");
  }

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search items…"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Unit
          <select value={baseUnitCode} onChange={(e) => setBaseUnitCode(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="">All</option>
            {units.map((u) => (
              <option key={u.id} value={u.code}>
                {u.code}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ItemStatus | "ALL")} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="ALL">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      ) : items.length === 0 && !loading ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">No items match these filters.</p>
          {hasActiveFilters ? (
            <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryButtonClass}`}>
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
          {items.map((item) => (
            <Link
              key={item.itemId}
              href={`/manager/admin/items/${item.itemId}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50"
            >
              <div className="min-w-0">
                <p className="text-xs font-mono text-zinc-500">{item.itemNumber}</p>
                <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {item.categoryName ?? "No category"} · {item.baseUnitCode ?? "No unit"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <StatusBadge label={item.status === "active" ? "Active" : "Inactive"} tone={item.status === "active" ? "success" : "neutral"} />
                <span className="text-xs font-medium text-amber-400">View / Edit →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
