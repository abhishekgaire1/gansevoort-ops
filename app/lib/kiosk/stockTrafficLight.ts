import type { StockLevel } from "@/app/lib/inventory/stockLevel";

/**
 * Simplified 3-color kiosk "traffic light" summary of the SAME
 * computeStockGauge levels the manager page's tank gauges already use --
 * never a second interpretation of what "healthy" means, just a coarser,
 * glance-friendly presentation for kiosk cards/strips that show no
 * percentage text at all. FULL/HEALTHY -> green, MEDIUM -> yellow,
 * LOW/EMPTY -> red.
 *
 * "neutral" covers the case computeStockGauge itself returns level=null:
 * no full-stock reference has been set for this item+location, so there
 * is nothing to gauge fullness against. The item still has real positive
 * stock (kiosk cards only ever show positive-balance items -- see
 * app/lib/kiosk/inventoryItems.ts) -- neither green nor red would be an
 * honest signal, so this renders as a plain neutral bar instead of
 * guessing.
 */
export type StockTrafficLight = "green" | "yellow" | "red" | "neutral";

export function stockTrafficLight(level: StockLevel | null): StockTrafficLight {
  switch (level) {
    case "FULL":
    case "HEALTHY":
      return "green";
    case "MEDIUM":
      return "yellow";
    case "LOW":
    case "EMPTY":
      return "red";
    default:
      return "neutral";
  }
}

export function stockTrafficLightClass(light: StockTrafficLight): string {
  switch (light) {
    case "green":
      return "bg-emerald-500";
    case "yellow":
      return "bg-yellow-500";
    case "red":
      return "bg-red-500";
    case "neutral":
      return "bg-zinc-600";
  }
}
