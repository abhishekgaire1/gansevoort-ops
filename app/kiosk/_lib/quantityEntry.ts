/**
 * Pure "which fields render, and is the entry complete" logic for the
 * unit + quantity screen, driven entirely by inventory_item_units metadata
 * -- no item-specific rules anywhere (see the approved kiosk UI plan §4).
 */

export interface ItemUnitOptionLike {
  requiresActualMeasurement: boolean;
  conversionFactor: string | null;
}

export type QuantityEntryLayout =
  | { kind: "actual_measurement" }
  | { kind: "fixed_conversion"; conversionFactor: string }
  | { kind: "simple_count" };

export function resolveQuantityEntryLayout(unit: ItemUnitOptionLike): QuantityEntryLayout {
  if (unit.requiresActualMeasurement) {
    return { kind: "actual_measurement" };
  }
  if (unit.conversionFactor !== null) {
    return { kind: "fixed_conversion", conversionFactor: unit.conversionFactor };
  }
  // Defensive: the DB's XOR constraint guarantees requiresActualMeasurement
  // and conversionFactor never both come back false/null, but degrade to a
  // plain quantity field rather than crash if that were ever violated.
  return { kind: "simple_count" };
}

function toPositiveFiniteNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Read-only preview only -- never sent to the server, never editable. */
export function computeConversionPreview(enteredQuantity: string, conversionFactor: string): number | null {
  const qty = toPositiveFiniteNumber(enteredQuantity);
  const factor = toPositiveFiniteNumber(conversionFactor);
  if (qty === null || factor === null) return null;
  return qty * factor;
}

/**
 * Advisory only -- the RPC remains the sole source of truth for every
 * business rule. This only decides whether Continue/Confirm should be
 * enabled, not whether the backend will ultimately accept the submission.
 */
export function isQuantityEntryComplete(
  layout: QuantityEntryLayout,
  enteredQuantity: string,
  measuredBaseQuantity: string | null
): boolean {
  if (toPositiveFiniteNumber(enteredQuantity) === null) {
    return false;
  }
  if (layout.kind === "actual_measurement") {
    return measuredBaseQuantity !== null && toPositiveFiniteNumber(measuredBaseQuantity) !== null;
  }
  return true;
}
