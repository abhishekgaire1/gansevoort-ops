/**
 * Loading placeholder for the quantity-entry screen, shown while the
 * item's withdrawal unit is still loading. Matches the real content's
 * footprint -- one value-card-height block plus a keypad-sized grid -- so
 * the fetch finishing doesn't itself cause the screen to resize underneath
 * the employee.
 */
export function QuantityEntrySkeleton() {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-6" aria-hidden="true">
      <div className="h-32 w-full animate-pulse rounded-2xl border-2 border-kiosk-border bg-kiosk-surface" />
      <div className="grid w-full grid-cols-3 gap-3">
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={index} className="aspect-square animate-pulse rounded-2xl bg-kiosk-surface" />
        ))}
      </div>
    </div>
  );
}
