"use client";

import type { CartLine } from "@/app/kiosk/_lib/kioskReducer";

function formatQuantity(value: string): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

interface CartLineRowProps {
  line: CartLine;
  onEdit: (lineId: string) => void;
  onRemove: (lineId: string) => void;
}

/**
 * One Review Withdrawal row (2A.5 Part 7): item name is the strongest
 * element, quantity is a compact gold treatment on the right (never a
 * giant circular badge -- that stopped scaling once more than one item
 * could be in a cart), category + Edit/Remove sit below in a muted
 * second line. The physical source location is NOT repeated here -- it's
 * the enclosing group's heading (CartReviewGroups), never duplicated per
 * row.
 */
export function CartLineRow({ line, onEdit, onRemove }: CartLineRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-kiosk-border px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-base font-semibold text-kiosk-text">{line.itemName}</p>
        <div className="mt-1 flex items-center gap-3">
          <span className="truncate text-sm text-kiosk-text-muted">{line.categoryName}</span>
          <button
            type="button"
            onClick={() => onEdit(line.id)}
            className="-mx-2 -my-3 px-2 py-3 text-sm font-medium text-kiosk-text-subtle underline-offset-2 transition hover:text-kiosk-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onRemove(line.id)}
            className="-mx-2 -my-3 px-2 py-3 text-sm font-medium text-kiosk-coral-strong underline-offset-2 transition hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
          >
            Remove
          </button>
        </div>
      </div>
      <p className="shrink-0 whitespace-nowrap text-lg font-semibold text-kiosk-amber-strong">
        {formatQuantity(line.enteredQuantity)} {line.baseUnitCode}
      </p>
    </div>
  );
}
