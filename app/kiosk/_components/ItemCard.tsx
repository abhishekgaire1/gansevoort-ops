"use client";

interface ItemCardProps {
  item: { id: string; name: string; categoryName: string };
  onSelect: (id: string) => void;
}

export function ItemCard({ item, onSelect }: ItemCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className="flex min-h-28 flex-col justify-center gap-1 rounded-2xl border-2 border-zinc-700 bg-zinc-900 px-5 py-4 text-left transition hover:border-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
    >
      <span className="text-lg font-semibold text-zinc-50">{item.name}</span>
      <span className="text-sm text-zinc-400">{item.categoryName}</span>
    </button>
  );
}
