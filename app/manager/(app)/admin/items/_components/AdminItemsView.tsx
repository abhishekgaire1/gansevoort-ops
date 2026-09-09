"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listAdminItemsAction } from "@/app/actions/adminItems";
import type { AdminItemSummary, ItemStatus, AdminItemSort } from "@/app/lib/admin/items";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { panelClass, inputClass, selectClass, labelClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableRowClass, tableCellClass } from "@/app/components/manager/surfaces";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Items list (redesigned, full width) -- search/category/unit/
 * inventory-vs-expense/status filters, sort, and a result count, all
 * re-fetching through the same debounced-refetch convention this view
 * already used, now drawing its chrome from surfaces.ts (the "sturdy
 * desktop application" tokens introduced for the purchase-document
 * workspace) instead of ad-hoc rounded-2xl cards.
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
  const [sort, setSort] = useState<AdminItemSort>("name");
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
    listAdminItemsAction(search.trim() || null, categoryId || null, baseUnitCode || null, status === "ALL" ? null : status, sort).then((result) => {
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
  }, [search, categoryId, baseUnitCode, status, sort]);

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
      <div className={`${panelClass} flex flex-wrap items-end gap-3 p-4`}>
        <label className={`flex flex-1 min-w-[200px] flex-col gap-1 ${labelClass}`}>
          Search
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search items…" className={inputClass} />
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${selectClass} w-40`}>
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Unit
          <select value={baseUnitCode} onChange={(e) => setBaseUnitCode(e.target.value)} className={`${selectClass} w-28`}>
            <option value="">All</option>
            {units.map((u) => (
              <option key={u.id} value={u.code}>
                {u.code}
              </option>
            ))}
          </select>
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ItemStatus | "ALL")} className={`${selectClass} w-28`}>
            <option value="ALL">All</option>
            <option value="active">Active</option>
            <option value="inactive">Archived</option>
          </select>
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as AdminItemSort)} className={`${selectClass} w-36`}>
            <option value="name">Name</option>
            <option value="item_number">Item #</option>
            <option value="category">Category</option>
            <option value="updated">Last updated</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {loading ? "Loading…" : `${items.length} item${items.length === 1 ? "" : "s"}`}
        </span>
        {hasActiveFilters ? (
          <button type="button" onClick={clearFilters} className="text-amber-400 hover:text-amber-300">
            Clear filters
          </button>
        ) : null}
      </div>

      {error ? (
        <div className={`${panelClass} p-4`}>
          <p className="text-sm text-red-300">{error}</p>
        </div>
      ) : items.length === 0 && !loading ? (
        <div className={`${panelClass} p-6`}>
          <p className="text-sm text-zinc-500">No items match these filters.</p>
          {hasActiveFilters ? (
            <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryButtonClass}`}>
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={tableHeadClass}>
              <tr>
                <th className={tableHeadCellClass}>Item #</th>
                <th className={tableHeadCellClass}>Name</th>
                <th className={tableHeadCellClass}>Category</th>
                <th className={tableHeadCellClass}>Unit</th>
                <th className={tableHeadCellClass}>Status</th>
                <th className={tableHeadCellClass}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.itemId} className={tableRowClass}>
                  <td className={`${tableCellClass} font-mono text-xs text-zinc-500`}>{item.itemNumber}</td>
                  <td className={tableCellClass}>
                    <Link href={`/manager/admin/items/${item.itemId}`} className="font-medium text-zinc-100 hover:text-amber-300">
                      {item.name}
                    </Link>
                  </td>
                  <td className={tableCellClass}>{item.categoryName ?? "—"}</td>
                  <td className={tableCellClass}>{item.baseUnitCode ?? "—"}</td>
                  <td className={tableCellClass}>
                    <StatusBadge label={item.status === "active" ? "Active" : "Archived"} tone={item.status === "active" ? "success" : "neutral"} />
                  </td>
                  <td className={`${tableCellClass} text-right`}>
                    <Link href={`/manager/admin/items/${item.itemId}`} className="text-xs font-medium text-amber-400 hover:text-amber-300">
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
