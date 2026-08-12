"use client";

interface StationCardProps {
  station: { id: string; name: string };
  selected?: boolean;
  onSelect: (id: string) => void;
}

export function StationCard({ station, selected, onSelect }: StationCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(station.id)}
      aria-pressed={selected}
      className={`min-h-24 rounded-2xl border-2 px-6 py-5 text-left text-xl font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber ${
        selected
          ? "border-kiosk-amber bg-kiosk-amber/10 text-kiosk-amber-strong"
          : "border-kiosk-border bg-kiosk-surface text-kiosk-text hover:border-kiosk-border-strong"
      }`}
    >
      {station.name}
    </button>
  );
}
