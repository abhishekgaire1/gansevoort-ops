"use client";

import type { ReactNode } from "react";

interface ItemSearchCategory {
  id: string;
  name: string;
}

interface ItemSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  categories: ItemSearchCategory[];
  activeCategoryId: string | null;
  onCategoryChange: (categoryId: string | null) => void;
  /** Rendered between the search box and the category chips (2A.5 §13's
   * required order: search -> Recently Used -> categories -> grid) --
   * e.g. RecentItemsStrip. Omitted entirely while there's nothing to
   * show (no recent items, or the employee is actively typing a query). */
  recentSlot?: ReactNode;
}

/**
 * The primary action on the item-selection screen, so it's built to read
 * that way: a brighter surface than the surrounding page (kiosk-surface-
 * raised, not the plain kiosk-surface every other card uses), a clear
 * border, and an explicit amber focus treatment -- obviously interactive
 * even before it's tapped.
 */
export function ItemSearch({ query, onQueryChange, categories, activeCategoryId, onCategoryChange, recentSlot }: ItemSearchProps) {
  return (
    <div className="mb-3 flex flex-col gap-3">
      <div className="relative">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className="pointer-events-none absolute left-5 top-1/2 h-6 w-6 -translate-y-1/2 text-kiosk-text-subtle"
        >
          <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.75" />
          <path d="M17 17L13.5 13.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search inventory…"
          aria-label="Search inventory"
          className="w-full rounded-2xl border-2 border-kiosk-border-strong bg-kiosk-surface-raised py-5 pl-14 pr-14 text-xl text-kiosk-text placeholder:text-kiosk-text-subtle transition focus:border-kiosk-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-2xl text-kiosk-text-subtle hover:text-kiosk-text"
          >
            ✕
          </button>
        ) : null}
      </div>
      {recentSlot}
      <div className="flex gap-3 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onCategoryChange(null)}
          aria-pressed={activeCategoryId === null}
          className={`shrink-0 rounded-full px-4 py-2.5 text-base font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber ${
            activeCategoryId === null
              ? "bg-kiosk-amber text-kiosk-amber-ink"
              : "bg-kiosk-surface-raised text-kiosk-text-muted hover:bg-kiosk-border-strong"
          }`}
        >
          All
        </button>
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => onCategoryChange(category.id)}
            aria-pressed={activeCategoryId === category.id}
            className={`shrink-0 rounded-full px-4 py-2.5 text-base font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber ${
              activeCategoryId === category.id
                ? "bg-kiosk-amber text-kiosk-amber-ink"
                : "bg-kiosk-surface-raised text-kiosk-text-muted hover:bg-kiosk-border-strong"
            }`}
          >
            {category.name}
          </button>
        ))}
      </div>
    </div>
  );
}
