interface ValueCardProps {
  label: string;
  value: string;
  unit: string;
}

/**
 * Large, always-dominant readout for the single withdrawal-quantity field
 * (withdrawal-unit simplification: there is exactly one field now, always
 * in the item's base unit, so this is a plain display -- not a tappable
 * control -- QuantityKeypad below it is implicitly always the thing typing
 * into it).
 *
 * Fixed height (h-32), regardless of value length: typing more digits must
 * never resize this card and shift the keypad/Continue button below it.
 */
export function ValueCard({ label, value, unit }: ValueCardProps) {
  return (
    <div className="flex h-32 w-full flex-col justify-center rounded-2xl border-2 border-kiosk-amber bg-kiosk-amber/5 px-6 text-left">
      <span className="text-xs font-semibold uppercase tracking-wide text-kiosk-text-muted">{label}</span>
      <span className="mt-2 flex items-baseline gap-2">
        <span className="text-5xl font-bold tabular-nums text-kiosk-text sm:text-6xl">{value || "0"}</span>
        {unit ? <span className="text-xl font-medium text-kiosk-text-muted">{unit}</span> : null}
      </span>
    </div>
  );
}
