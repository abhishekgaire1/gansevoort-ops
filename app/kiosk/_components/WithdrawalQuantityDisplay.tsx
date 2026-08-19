interface WithdrawalQuantityDisplayProps {
  value: string;
  unit: string;
}

/**
 * The dominant visual element of the quantity-entry workspace -- a large,
 * touchscreen-appropriate readout of what's about to be withdrawn. Replaces
 * the old compact ValueCard on this screen (ValueCard itself is untouched
 * and may still be used elsewhere). font-size uses clamp() so the number
 * stays impressively large on a full kiosk display while still shrinking
 * gracefully on a smaller tablet viewport, rather than a fixed size that
 * would either overflow or look small depending on screen.
 *
 * Plain display, not a tappable control -- QuantityKeypad is implicitly
 * always the thing typing into it, exactly like the ValueCard it replaces
 * here.
 */
export function WithdrawalQuantityDisplay({ value, unit }: WithdrawalQuantityDisplayProps) {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border border-kiosk-amber/40 bg-kiosk-amber/5 px-4 py-6 text-center">
      <span className="text-xs font-semibold uppercase tracking-wide text-kiosk-text-muted">Withdraw Quantity</span>
      <span className="flex items-baseline justify-center gap-3">
        <span
          className="font-bold tabular-nums leading-none text-kiosk-text"
          style={{ fontSize: "clamp(3.5rem, 8vw, 7.5rem)" }}
        >
          {value || "0"}
        </span>
        {unit ? (
          <span className="pb-1 text-xl font-semibold text-kiosk-amber-strong sm:text-2xl">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}
