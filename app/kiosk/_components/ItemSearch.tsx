"use client";

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
}

export function ItemSearch({ query, onQueryChange, categories, activeCategoryId, onCategoryChange }: ItemSearchProps) {
  return (
    <div className="mb-6 flex flex-col gap-4">
      <div className="relative">
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search items..."
          aria-label="Search items"
          className="w-full rounded-2xl border-2 border-zinc-700 bg-zinc-900 px-6 py-5 text-xl text-zinc-50 placeholder:text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-2xl text-zinc-400 hover:text-zinc-100"
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onCategoryChange(null)}
          aria-pressed={activeCategoryId === null}
          className={`shrink-0 rounded-full px-5 py-3 text-base font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
            activeCategoryId === null ? "bg-amber-400 text-zinc-950" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
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
            className={`shrink-0 rounded-full px-5 py-3 text-base font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
              activeCategoryId === category.id ? "bg-amber-400 text-zinc-950" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            {category.name}
          </button>
        ))}
      </div>
    </div>
  );
}
