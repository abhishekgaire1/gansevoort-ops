"use client";

import { useState } from "react";
import { UnitSelector } from "./UnitSelector";
import { QuantityKeypad } from "./QuantityKeypad";
import { computeConversionPreview, resolveQuantityEntryLayout } from "@/app/kiosk/_lib/quantityEntry";
import type { KioskItemUnitOption } from "@/app/actions/inventoryItemUnits";

interface QuantityEntryFormProps {
  units: KioskItemUnitOption[];
  baseUnitName: string;
  selectedUnitId: string | null;
  onUnitChange: (unitId: string) => void;
  enteredQuantity: string;
  onQuantityChange: (value: string) => void;
  measuredBaseQuantity: string | null;
  onMeasuredQuantityChange: (value: string) => void;
}

/**
 * Owns the "which fields to show" branching from the approved plan §4,
 * kept separate from QuantityKeypad itself so that component stays a dumb,
 * reusable input. Two independent QuantityKeypad instances are needed for
 * the actual-measurement layout, so each needs to know which field it's
 * currently editing -- a simple focus toggle, not global keypad state.
 */
export function QuantityEntryForm({
  units,
  baseUnitName,
  selectedUnitId,
  onUnitChange,
  enteredQuantity,
  onQuantityChange,
  measuredBaseQuantity,
  onMeasuredQuantityChange,
}: QuantityEntryFormProps) {
  const [activeField, setActiveField] = useState<"entered" | "measured">("entered");

  const selectedUnit = units.find((unit) => unit.unitId === selectedUnitId) ?? null;
  if (!selectedUnit) {
    return null;
  }

  const layout = resolveQuantityEntryLayout(selectedUnit);
  const unitOptions = units.map((unit) => ({ unitId: unit.unitId, unitName: unit.unitName }));

  return (
    <div className="flex flex-col gap-6">
      <UnitSelector options={unitOptions} selectedUnitId={selectedUnitId} onSelect={onUnitChange} />

      <div className="flex flex-col items-center gap-3">
        <label className="text-lg text-zinc-400">
          {layout.kind === "actual_measurement" ? `Package count (${selectedUnit.unitName})` : `Quantity (${selectedUnit.unitName})`}
        </label>
        <button
          type="button"
          onClick={() => setActiveField("entered")}
          aria-label="Edit quantity"
          className={`w-full max-w-xs rounded-2xl border-2 px-6 py-5 text-center text-4xl font-semibold tabular-nums transition ${
            activeField === "entered" ? "border-amber-400 bg-zinc-900" : "border-zinc-700 bg-zinc-900"
          }`}
        >
          {enteredQuantity || "0"}
        </button>
      </div>

      {layout.kind === "fixed_conversion" ? (
        (() => {
          const preview = computeConversionPreview(enteredQuantity, layout.conversionFactor);
          return preview !== null ? (
            <p className="text-center text-lg text-zinc-400">
              ≈ {preview} {baseUnitName} total
            </p>
          ) : null;
        })()
      ) : null}

      {layout.kind === "actual_measurement" ? (
        <div className="flex flex-col items-center gap-3">
          <label className="text-lg text-zinc-400">Actual weight measured ({baseUnitName}) — required</label>
          <button
            type="button"
            onClick={() => setActiveField("measured")}
            aria-label="Edit actual measured quantity"
            className={`w-full max-w-xs rounded-2xl border-2 px-6 py-5 text-center text-4xl font-semibold tabular-nums transition ${
              activeField === "measured" ? "border-amber-400 bg-zinc-900" : "border-zinc-700 bg-zinc-900"
            }`}
          >
            {measuredBaseQuantity || "0"}
          </button>
        </div>
      ) : null}

      <QuantityKeypad
        value={activeField === "entered" ? enteredQuantity : (measuredBaseQuantity ?? "")}
        onChange={activeField === "entered" ? onQuantityChange : onMeasuredQuantityChange}
      />
    </div>
  );
}
