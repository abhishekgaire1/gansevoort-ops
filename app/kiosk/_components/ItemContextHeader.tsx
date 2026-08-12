"use client";

interface ItemContextHeaderProps {
  itemName: string;
  trackingBasis: string;
  baseUnitName: string;
  onBack: () => void;
}

/**
 * Item-identity hierarchy for the quantity-entry screen: a compact item
 * title, then the item's fixed tracking basis and canonical withdrawal
 * unit (derived from inventory_items.base_unit_id -> units.unit_type,
 * never item-specific logic). Under the withdrawal-unit simplification
 * there is no separate "entering as" line -- the base unit IS the only
 * unit an employee ever withdraws in.
 *
 * The caption shows the unit's full display name ("Pound"), not its short
 * code -- the value card below uses the code ("43.6 LB") since that's
 * compact and dominant there, but this caption is meant to read like plain
 * language.
 */
export function ItemContextHeader({ itemName, trackingBasis, baseUnitName, onBack }: ItemContextHeaderProps) {
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-3 rounded-full px-3 py-2 text-sm font-medium text-kiosk-text-subtle transition hover:bg-kiosk-surface-raised hover:text-kiosk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
      >
        ← Back
      </button>
      <h1 className="text-xl font-semibold tracking-tight text-kiosk-text sm:text-2xl">{itemName}</h1>
      {trackingBasis ? (
        <p className="mt-1 text-sm font-medium text-kiosk-text-subtle">
          <span className="uppercase tracking-wide">{trackingBasis}</span>
          {baseUnitName ? ` · ${baseUnitName}` : ""}
        </p>
      ) : null}
    </div>
  );
}
