"use client";

import type { KioskUsageUnitOption } from "@/app/actions/withdrawalUnit";

interface UsageUnitSelectorProps {
  primary: KioskUsageUnitOption;
  secondary: KioskUsageUnitOption;
  selectedUnitId: string;
  onSelect: (unitId: string) => void;
}

/**
 * Rendered ONLY when an item has a confirmed secondary kiosk usage unit
 * (approved-plan §11 -- a one-unit item gets no selector at all, just
 * rigid quantity entry). Two large touch targets, never a dropdown --
 * this is a kiosk, not a desktop form. Defaults to primary (KioskApp
 * only mounts this once usageUnits has loaded, and USAGE_UNITS_LOADED
 * always seeds selectedUsageUnitId with primary unless a pending edit
 * asks to preserve secondary).
 */
export function UsageUnitSelector({ primary, secondary, selectedUnitId, onSelect }: UsageUnitSelectorProps) {
  const options = [primary, secondary];
  return (
    <div className="flex gap-2" role="group" aria-label="Withdraw in">
      {options.map((option) => {
        const selected = option.unitId === selectedUnitId;
        return (
          <button
            key={option.unitId}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(option.unitId)}
            className={`flex-1 rounded-lg border px-3 py-2 text-center transition ${
              selected ? "border-kiosk-amber-strong bg-kiosk-amber/10" : "border-kiosk-border bg-kiosk-surface hover:bg-kiosk-surface-raised"
            }`}
          >
            <span className="block text-sm font-semibold text-kiosk-text">{option.unitName}</span>
            <span className="block text-xs text-kiosk-text-muted">{option.unitCode}</span>
          </button>
        );
      })}
    </div>
  );
}
