/**
 * Shared button role classNames (Manager UX & Navigation Milestone, Part
 * 15) -- plain className strings, not components, since every call site
 * already uses a plain <button>/<Link> and a full wrapper component
 * would be a bigger abstraction than this milestone needs. One obvious
 * PRIMARY (warm gold) per screen/task; SECONDARY is a visible bordered
 * button, never faint-to-the-point-of-looking-disabled; DESTRUCTIVE is
 * restrained, only for genuinely destructive actions.
 */
export const primaryButtonClass = "rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40";
export const secondaryButtonClass = "rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";
export const destructiveButtonClass = "rounded-full border border-red-900 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-950/40 disabled:opacity-40";
export const textLinkClass = "text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300";
