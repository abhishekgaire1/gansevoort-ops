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
  "aspect-square max-h-16 rounded-xl bg-kiosk-surface-raised text-2xl font-medium text-kiosk-text transition active:bg-kiosk-border-strong disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber sm:max-h-20 sm:text-3xl";

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

  function clearAll() {
    onChange("");
  }

  return (
    <div className="mx-auto grid w-full max-w-sm grid-cols-3 gap-2 sm:gap-3">
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
        className="aspect-square max-h-16 rounded-xl bg-kiosk-surface text-xl font-medium text-kiosk-text-muted transition active:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber sm:max-h-20"
      >
        ←
      </button>
      <button
        type="button"
        onClick={clearAll}
        disabled={value === ""}
        aria-label="Clear quantity"
        className="col-span-3 rounded-xl bg-kiosk-surface py-1.5 text-sm font-medium text-kiosk-text-muted transition active:bg-kiosk-surface-raised disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
      >
        Clear
      </button>
    </div>
  );
}
