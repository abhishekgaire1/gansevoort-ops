"use client";

import { computeStockGauge } from "@/app/lib/inventory/stockLevel";
import { stockTrafficLight, stockTrafficLightClass } from "@/app/lib/kiosk/stockTrafficLight";

interface ItemCardProps {
  item: {
    id: string;
    name: string;
    categoryName: string;
    baseUnitCode: string;
    totalAvailableQuantity: number;
    positiveLocationCount: number;
    singleLocation: { fullReferenceQuantity: number | null } | null;
  };
  onSelect: (id: string) => void;
}

/**
 * Deliberately minimal: item name, category, and a barely-noticeable
 * color-coded underline -- no quantity text, no percentage, no
 * location-count caption, no fill/track. It is a signal, not a gauge, so
 * it renders as a single solid-color line at a fixed subtle width rather
 * than a proportional fill against a track -- a track+fill pairing reads
 * as a progress bar, which would compete with the item name for
 * attention. Exact numbers live one tap away on the quantity screen.
 */
export function ItemCard({ item, onSelect }: ItemCardProps) {
  // Multi-location items have no single reference to gauge fullness
  // against (see KioskInventoryItem.singleLocation) -- rendered neutral,
  // same as an item with no full-stock reference set at all.
  const gauge = item.singleLocation ? computeStockGauge(item.totalAvailableQuantity, item.singleLocation.fullReferenceQuantity) : null;
  const light = stockTrafficLight(gauge?.level ?? null);

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className="flex min-h-20 flex-col justify-center gap-1 rounded-2xl border-2 border-kiosk-border bg-kiosk-surface px-5 py-3 text-left transition hover:border-kiosk-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
    >
      <span className="text-lg font-semibold text-kiosk-text">{item.name}</span>
      <span className="text-sm text-kiosk-text-muted">{item.categoryName}</span>
      <div className={`mt-1.5 h-0.5 w-3/5 rounded-full ${stockTrafficLightClass(light)}`} />
    </button>
  );
}
