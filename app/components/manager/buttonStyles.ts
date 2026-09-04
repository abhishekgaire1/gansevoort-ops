/**
 * Shared button role classNames (Desktop Application Design System pass)
 * -- plain className strings, not components, since every call site
 * already uses a plain <button>/<Link> and a full wrapper component
 * would be a bigger abstraction than this needs. Sturdy desktop controls,
 * never oversized pills: 6-10px corner radii (rounded-lg = 8px), a fixed
 * ~36px height (py-2 + leading-5 text), one obvious PRIMARY (warm gold)
 * per screen/task, a visible (never faint-to-invisible) SECONDARY
 * border, and a restrained DESTRUCTIVE only for genuinely destructive
 * actions. Every call site inherits this automatically -- never a
 * per-screen one-off button style.
 */
export const primaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg bg-amber-400 px-4 text-sm font-semibold leading-none text-zinc-950 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-zinc-600 px-4 text-sm font-medium leading-none text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";
export const destructiveButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-red-900 px-4 text-sm font-medium leading-none text-red-400 transition-colors hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40";
export const textLinkClass = "text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200";
