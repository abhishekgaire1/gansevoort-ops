"use client";

interface QuantityKeypadProps {
  value: string;
  onChange: (next: string) => void;
  allowDecimal?: boolean;
}

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

const KEY_CLASSES =
  "aspect-square rounded-2xl bg-zinc-800 text-2xl font-medium text-zinc-50 transition active:bg-zinc-700 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400";

/**
 * Decimal-capable numeric input, reused for both package-count and
 * measured-weight fields -- distinct from PIN's NumericKeypad, which is
 * fixed-length integer digits only. Fractional package counts and measured
 * weights are both explicitly required (docs/BUSINESS_RULES.md: "Half-box
 * and fractional-package quantities must be supported").
 */
export function QuantityKeypad({ value, onChange, allowDecimal = true }: QuantityKeypadProps) {
  function appendDigit(digit: string) {
    onChange(value + digit);
  }

  function appendDecimal() {
    if (!allowDecimal || value.includes(".")) return;
    onChange(value === "" ? "0." : value + ".");
  }

  function deleteLast() {
    onChange(value.slice(0, -1));
  }

  return (
    <div className="mx-auto grid w-full max-w-xs grid-cols-3 gap-3">
      {DIGIT_ROWS.flat().map((digit) => (
        <button key={digit} type="button" onClick={() => appendDigit(digit)} className={KEY_CLASSES}>
          {digit}
        </button>
      ))}
      <button
        type="button"
        onClick={appendDecimal}
        disabled={!allowDecimal}
        aria-label="Decimal point"
        className={KEY_CLASSES}
      >
        .
      </button>
      <button type="button" onClick={() => appendDigit("0")} className={KEY_CLASSES}>
        0
      </button>
      <button
        type="button"
        onClick={deleteLast}
        aria-label="Delete last character"
        className="aspect-square rounded-2xl bg-zinc-900 text-lg font-medium text-zinc-400 transition active:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
      >
        Del
      </button>
    </div>
  );
}
