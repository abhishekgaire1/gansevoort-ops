"use client";

interface UnitOption {
  unitId: string;
  unitName: string;
}

interface UnitSelectorProps {
  options: UnitOption[];
  selectedUnitId: string | null;
  onSelect: (unitId: string) => void;
}

/** Rendered only when the item has more than one active entry unit --
 * skipping a pointless single-option picker. */
export function UnitSelector({ options, selectedUnitId, onSelect }: UnitSelectorProps) {
  if (options.length <= 1) {
    return null;
  }
  return (
    <div className="mb-6 flex flex-wrap gap-3" role="radiogroup" aria-label="Unit">
      {options.map((option) => (
        <button
          key={option.unitId}
          type="button"
          role="radio"
          aria-checked={option.unitId === selectedUnitId}
          onClick={() => onSelect(option.unitId)}
          className={`rounded-full px-6 py-3 text-lg font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
            option.unitId === selectedUnitId ? "bg-amber-400 text-zinc-950" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          }`}
        >
          {option.unitName}
        </button>
      ))}
    </div>
  );
}
