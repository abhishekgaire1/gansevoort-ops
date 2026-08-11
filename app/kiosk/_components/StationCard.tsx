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
      className={`min-h-24 rounded-2xl border-2 px-6 py-5 text-left text-xl font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
        selected
          ? "border-amber-400 bg-amber-400/10 text-amber-200"
          : "border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-zinc-500"
      }`}
    >
      {station.name}
    </button>
  );
}
