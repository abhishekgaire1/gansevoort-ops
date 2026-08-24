"use client";

import { useState } from "react";
import Link from "next/link";
import type { ManagerInventoryCategoryItem } from "@/app/lib/categories/managerInventoryCategories";
import { stockLevelTextClass } from "@/app/lib/inventory/stockLevel";

/**
 * Compact search + item rows -- no meaningless cross-unit total anywhere
 * (Part 21/44). One row per item+location balance, matching Current
 * Inventory's own convention; location shown inline so multi-location
 * orgs stay honest without a separate grouping formula.
 */
export function InventoryCategoryItemList({ items }: { items: ManagerInventoryCategoryItem[] }) {
  const [search, setSearch] = useState("");

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="text-sm text-zinc-500">No active inventory items currently use this category.</p>
      </div>
    );
  }

  const term = search.trim().toLowerCase();
  const filtered = term ? items.filter((i) => i.name.toLowerCase().includes(term) || (i.itemNumber ?? "").toLowerCase().includes(term)) : items;

  return (
    <div className="flex flex-col gap-3">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search items…"
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
      />

      {filtered.length === 0 ? (
        <p className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">No items match your search.</p>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
          {filtered.map((item) => (
            <Link
              key={`${item.itemId}-${item.locationId}`}
              href={`/manager/inventory/items/${item.itemId}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {item.itemNumber ?? "—"}
                  {item.locationName ? ` · ${item.locationName}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-right">
                <div>
                  <p className="text-xs text-zinc-500">Current Stock</p>
                  <p className="text-sm text-zinc-100">
                    {item.balance} {item.baseUnitCode}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Status</p>
                  <p className={`text-sm font-medium ${stockLevelTextClass(item.level)}`}>{item.levelLabel}</p>
                </div>
                <span className="text-xs font-medium text-amber-400">View Item →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
