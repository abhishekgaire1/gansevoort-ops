"use client";

import type { CartLine } from "@/app/kiosk/_lib/kioskReducer";
import { CartLineRow } from "./CartLineRow";

interface CartReviewGroupsProps {
  cart: CartLine[];
  onEdit: (lineId: string) => void;
  onRemove: (lineId: string) => void;
}

/**
 * Review Withdrawal's core: cart lines grouped by PHYSICAL SOURCE
 * LOCATION (2A.5 Part 6) -- "what am I taking, how much, from where" reads
 * naturally when the answer to "where" is a group heading shown once,
 * never repeated under every item that shares it. Group order follows
 * first-appearance in the cart (stable, not re-sorted alphabetically) so
 * the order matches how the employee actually shopped.
 */
export function CartReviewGroups({ cart, onEdit, onRemove }: CartReviewGroupsProps) {
  const groups = new Map<string, { name: string; lines: CartLine[] }>();
  for (const line of cart) {
    const group = groups.get(line.sourceLocationId);
    if (group) {
      group.lines.push(line);
    } else {
      groups.set(line.sourceLocationId, { name: line.sourceLocationName, lines: [line] });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {Array.from(groups.values()).map((group) => (
        <div key={group.name} className="overflow-hidden rounded-2xl border border-kiosk-border bg-kiosk-surface">
          <p className="border-b border-kiosk-border bg-kiosk-surface-raised px-4 py-2 text-xs font-semibold uppercase tracking-wider text-kiosk-text-muted">
            {group.name}
          </p>
          <div>
            {group.lines.map((line) => (
              <CartLineRow key={line.id} line={line} onEdit={onEdit} onRemove={onRemove} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
