"use client";

interface NumericKeypadProps {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  disabled?: boolean;
}

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

const KEY_CLASSES =
  "aspect-square rounded-2xl bg-zinc-800 text-3xl font-medium text-zinc-50 transition active:bg-zinc-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400";

/** PIN-only: fixed-length digit taps, no decimal point, no backspace-heavy
 * editing -- distinct from QuantityKeypad's decimal-capable input. */
export function NumericKeypad({ onDigit, onDelete, disabled }: NumericKeypadProps) {
  return (
    <div className="mx-auto grid w-full max-w-xs grid-cols-3 gap-4">
      {DIGIT_ROWS.flat().map((digit) => (
        <button key={digit} type="button" disabled={disabled} onClick={() => onDigit(digit)} className={KEY_CLASSES}>
          {digit}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={onDelete}
        aria-label="Delete last digit"
        className="aspect-square rounded-2xl bg-zinc-900 text-lg font-medium text-zinc-400 transition active:bg-zinc-800 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
      >
        Del
      </button>
      <button type="button" disabled={disabled} onClick={() => onDigit("0")} className={KEY_CLASSES}>
        0
      </button>
      <span aria-hidden="true" />
    </div>
  );
}
