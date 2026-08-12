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
      className="flex min-h-24 flex-col justify-center gap-1 rounded-2xl border-2 border-kiosk-border bg-kiosk-surface px-5 py-3 text-left transition hover:border-kiosk-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
    >
      <span className="text-lg font-semibold text-kiosk-text">{item.name}</span>
      <span className="text-sm text-kiosk-text-muted">{item.categoryName}</span>
    </button>
  );
}
