"use client";

import { computeStockGauge } from "@/app/lib/inventory/stockLevel";
import { stockTrafficLight, stockTrafficLightClass } from "@/app/lib/kiosk/stockTrafficLight";
import type { KioskInventoryItem } from "@/app/actions/inventoryItems";

interface RecentItemsStripProps {
  items: KioskInventoryItem[];
  onSelect: (id: string) => void;
}

/**
 * Compact horizontal "Recently Used" row (2A.5 §13) -- same minimal
 * hierarchy as the main grid's ItemCard (name strongest, category
 * muted, a barely-noticeable stock underline, no quantity/percentage/
 * status text), just smaller and in a single scrollable row so it never
 * grows into a second grid of its own.
 */
export function RecentItemsStrip({ items, onSelect }: RecentItemsStripProps) {
  if (items.length === 0) return null;

  return (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-kiosk-text-muted">Recently Used</p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {items.map((item) => {
          const gauge = item.singleLocation ? computeStockGauge(item.totalAvailableQuantity, item.singleLocation.fullReferenceQuantity) : null;
          const light = stockTrafficLight(gauge?.level ?? null);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className="flex w-40 shrink-0 flex-col gap-1 rounded-xl border-2 border-kiosk-border bg-kiosk-surface px-4 py-2.5 text-left transition hover:border-kiosk-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
            >
              <span className="truncate text-sm font-semibold text-kiosk-text">{item.name}</span>
              <span className="truncate text-xs text-kiosk-text-muted">{item.categoryName}</span>
              <div className={`h-0.5 w-3/5 rounded-full ${stockTrafficLightClass(light)}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
