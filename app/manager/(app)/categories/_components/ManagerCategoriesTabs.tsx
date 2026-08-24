"use client";

import { useState } from "react";
import Link from "next/link";
import type { ManagerInventoryCategorySummary } from "@/app/lib/categories/managerInventoryCategories";
import type { ManagerExpenseCategorySummary } from "@/app/lib/categories/managerExpenseCategories";
import { formatEstimatedCost } from "@/app/lib/format/currency";

type Tab = "inventory" | "expenses";

export function ManagerCategoriesTabs({
  initialInventoryCategories,
  initialExpenseCategories,
}: {
  initialInventoryCategories: ManagerInventoryCategorySummary[];
  initialExpenseCategories: ManagerExpenseCategorySummary[];
}) {
  const [tab, setTab] = useState<Tab>("inventory");

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1 w-fit">
        <button
          type="button"
          onClick={() => setTab("inventory")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "inventory" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Inventory
        </button>
        <button
          type="button"
          onClick={() => setTab("expenses")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${tab === "expenses" ? "bg-amber-400 text-zinc-950" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          Expenses
        </button>
      </div>

      {tab === "inventory" ? <InventoryCategoriesList categories={initialInventoryCategories} /> : <ExpenseCategoriesList categories={initialExpenseCategories} />}
    </div>
  );
}

function InventoryCategoriesList({ categories }: { categories: ManagerInventoryCategorySummary[] }) {
  if (categories.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="text-sm text-zinc-500">No inventory categories are available.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
      {categories.map((c) => (
        <Link key={c.categoryId} href={`/manager/categories/inventory/${c.categoryId}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{c.name}</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {c.itemCount} inventory item{c.itemCount === 1 ? "" : "s"}
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-amber-400">View →</span>
        </Link>
      ))}
    </div>
  );
}

function ExpenseCategoriesList({ categories }: { categories: ManagerExpenseCategorySummary[] }) {
  if (categories.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="text-sm text-zinc-500">No expense categories are available.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
      {categories.map((c) => (
        <Link key={c.categoryId} href={`/manager/categories/expense/${c.categoryId}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{c.name}</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              This Month · {formatEstimatedCost(c.totalAmount)} · {c.lineCount} expense{c.lineCount === 1 ? "" : "s"}
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-amber-400">View →</span>
        </Link>
      ))}
    </div>
  );
}
