"use client";

interface ItemContextHeaderProps {
  itemName: string;
  /** Shown as a small muted line under the item name -- optional so callers
   * that never had a category available (none currently do) still compile
   * without passing it. */
  categoryName?: string;
  onBack: () => void;
}

/**
 * Item-identity header for the quantity-entry screen: back button + item
 * title, plus a small muted category line. The item's unit is deliberately
 * NOT repeated here as a separate caption (e.g. "COUNT · Piece") -- it's
 * already unambiguous from the quantity readout right below ("4 PIECE"),
 * and a second, differently-worded copy of the same fact only competed with
 * the actual task instead of supporting it.
 */
export function ItemContextHeader({ itemName, categoryName, onBack }: ItemContextHeaderProps) {
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onBack}
        className="mb-1 -ml-3 rounded-full px-3 py-2 text-sm font-medium text-kiosk-text-subtle transition hover:bg-kiosk-surface-raised hover:text-kiosk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
      >
        ← Back
      </button>
      <h1 className="text-xl font-semibold tracking-tight text-kiosk-text sm:text-2xl">{itemName}</h1>
      {categoryName ? <p className="mt-0.5 text-sm text-kiosk-text-muted">{categoryName}</p> : null}
    </div>
  );
}
