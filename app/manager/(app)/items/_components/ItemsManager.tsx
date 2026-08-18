"use client";

import { useMemo, useState } from "react";
import type { InventoryItemSummary } from "@/app/actions/itemMaster";

const APPROVAL_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  PENDING_REVIEW: "Needs review",
};

const APPROVAL_COLOR: Record<string, string> = {
  CONFIRMED: "bg-emerald-400/20 text-emerald-300",
  PENDING_REVIEW: "bg-amber-400/20 text-amber-300",
};

export function ItemsManager({ initialItems }: { initialItems: InventoryItemSummary[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const trimmed = search.trim().toLowerCase();
    if (!trimmed) return initialItems;
    return initialItems.filter((item) => item.name.toLowerCase().includes(trimmed));
  }, [initialItems, search]);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search items…"
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
      />

      <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No items found.</p>
        ) : (
          filtered.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-100">{item.name}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {item.disposition === "NON_INVENTORY" ? "Non-inventory" : (item.categoryName ?? "Uncategorized")}
                  {item.baseUnitCode ? ` · ${item.baseUnitCode}` : ""}
                  {item.createdVia === "AI_PROPOSED" ? " · AI-proposed" : ""}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${APPROVAL_COLOR[item.approvalStatus]}`}>
                {APPROVAL_LABEL[item.approvalStatus]}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
