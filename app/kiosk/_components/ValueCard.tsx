interface ValueCardProps {
  label: string;
  value: string;
  unit: string;
}

/**
 * Dominant readout for the single withdrawal-quantity field
 * (withdrawal-unit simplification: there is exactly one field now, always
 * in the item's base unit, so this is a plain display -- not a tappable
 * control -- QuantityKeypad below it is implicitly always the thing typing
 * into it).
 *
 * Fixed height, regardless of value length: typing more digits must never
 * resize this card and shift the keypad/Continue button below it. Kept
 * compact (not the huge card the original design used) -- this is
 * supporting readout, not the whole task surface.
 */
export function ValueCard({ label, value, unit }: ValueCardProps) {
  return (
    <div className="flex h-20 w-full flex-col justify-center rounded-2xl border-2 border-kiosk-amber bg-kiosk-amber/5 px-5 text-left">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-kiosk-text-muted">{label}</span>
      <span className="mt-0.5 flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums text-kiosk-text sm:text-4xl">{value || "0"}</span>
        {unit ? <span className="text-lg font-medium text-kiosk-text-muted">{unit}</span> : null}
      </span>
    </div>
  );
}
