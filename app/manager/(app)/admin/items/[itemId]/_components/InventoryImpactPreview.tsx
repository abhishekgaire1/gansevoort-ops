import { inlineWarningClass, inlineNeutralClass } from "@/app/components/manager/surfaces";

/**
 * Shared "current inventory will change" impact preview (spec sections
 * 10/13) -- used by both Adjust Inventory and the receipt-package-factor
 * correction flow. Location-by-location, with an explicit
 * negative-balance warning when applicable, never a vague "Save anyway."
 */
export interface ImpactLine {
  locationName: string;
  previousBalance: number;
  proposedBalance: number;
  delta: number;
}

export function InventoryImpactPreview({ lines, baseUnitCode, valuationEffect }: { lines: ImpactLine[]; baseUnitCode: string; valuationEffect: number | null }) {
  const anyNegative = lines.some((l) => l.proposedBalance < 0);

  return (
    <div className="flex flex-col gap-3">
      <div className={inlineNeutralClass}>
        <p className="font-semibold text-zinc-200">Current inventory will change</p>
        <p className="mt-1">This correction will create an inventory movement and update the current on-hand balance. Previously posted receipts and withdrawals will remain unchanged.</p>
      </div>
      <div className="flex flex-col gap-2">
        {lines.map((l, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm">
            <span className="text-zinc-300">{l.locationName}</span>
            <span className="tabular-nums text-zinc-200">
              {l.previousBalance} → {l.proposedBalance} {baseUnitCode}{" "}
              <span className={l.delta > 0 ? "text-emerald-400" : l.delta < 0 ? "text-red-400" : "text-zinc-500"}>
                ({l.delta > 0 ? "+" : ""}
                {l.delta})
              </span>
            </span>
          </div>
        ))}
      </div>
      {valuationEffect !== null ? (
        <p className="text-xs text-zinc-500">
          Estimated valuation effect: <span className="tabular-nums text-zinc-300">${valuationEffect.toFixed(2)}</span> (operational estimate, not an accounting valuation).
        </p>
      ) : null}
      {anyNegative ? (
        <div className={inlineWarningClass}>This correction would take one or more locations below zero on-hand quantity. Review carefully before confirming.</div>
      ) : null}
    </div>
  );
}
