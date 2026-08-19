import { computeStockGauge } from "@/app/lib/inventory/stockLevel";
import { stockTrafficLight, stockTrafficLightClass } from "@/app/lib/kiosk/stockTrafficLight";
import type { KioskLocationAvailability } from "@/app/actions/inventoryAvailability";

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * Kiosk stock visibility for the single-location case -- a compact source
 * card, not a large detailed block: a small location-pin glyph, the
 * location name (strong), the available quantity (muted, its own line),
 * and a hairline color-coded availability strip underneath. No percentage
 * text, no "Full"/"Healthy" label -- this is supporting context for the
 * withdrawal task, not the task itself. Reuses computeStockGauge (the SAME
 * function the manager inventory page uses) and the same 3-color mapping
 * the kiosk item cards use, so nothing here is a second interpretation of
 * stock state. Never shows price, invoice data, or any manager control.
 */
export function StockAvailabilityCard({ location }: { location: KioskLocationAvailability }) {
  const gauge = computeStockGauge(location.balance, location.fullReferenceQuantity);
  const light = stockTrafficLight(gauge.level);
  const quantity = formatQuantity(location.balance);

  return (
    <div className="w-full rounded-xl border border-kiosk-border bg-kiosk-surface-raised px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-kiosk-amber-strong"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10 18s6-5.686 6-10a6 6 0 1 0-12 0c0 4.314 6 10 6 10Z"
          />
          <circle cx="10" cy="8" r="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-kiosk-text">{location.locationName}</p>
          <p className="text-sm text-kiosk-text-muted">
            {quantity} {location.baseUnitCode} available
          </p>
        </div>
      </div>
      <div className="mt-2.5 h-px w-full overflow-hidden rounded-full bg-kiosk-border">
        <div className={`h-full ${stockTrafficLightClass(light)}`} style={{ width: `${gauge.level === null ? 100 : gauge.fillPercent}%` }} />
      </div>
    </div>
  );
}
