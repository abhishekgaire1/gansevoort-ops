/**
 * Shared desktop-application surface/typography tokens (Desktop
 * Application Design System pass) -- plain className strings, matching
 * buttonStyles.ts's own convention, so every workflow screen (Step 1/2/3
 * and beyond) draws from ONE definition of "what a panel/table/input
 * looks like" instead of each screen inventing its own card styling.
 *
 * Visual language: mostly 6-10px corner radii, restrained 1px borders,
 * a dark neutral surface hierarchy (app bg darkest, panel one step up,
 * row/input one step up again), tabular numerals + right alignment for
 * quantities/currency, and color reserved for meaning (green = confirmed
 * success, amber = active work/non-blocking attention, red = a genuine
 * blocker) -- never a decorative outline around every completed thing.
 */

// Surface hierarchy -- zinc-950 (app) -> zinc-900 (panel) -> zinc-800/50 (row/input).
export const panelClass = "rounded-lg border border-zinc-800 bg-zinc-900";
export const panelHeaderClass = "flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3";
export const panelBodyClass = "px-4 py-4";
export const panelTitleClass = "text-sm font-semibold text-zinc-100";
export const panelMetaClass = "text-xs text-zinc-500";

export const inputClass =
  "h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-50 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
export const selectClass = inputClass;
export const labelClass = "text-xs font-medium text-zinc-400";
export const fieldGroupClass = "flex flex-col gap-1";

// Tables -- sticky header, restrained row separators (never a bordered
// box around every cell), tabular numerals + right alignment reserved
// for quantities/currency columns.
export const tableWrapClass = "overflow-x-auto rounded-lg border border-zinc-800";
export const tableClass = "w-full min-w-max border-collapse text-left text-sm";
export const tableHeadClass = "sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900 text-[11px] font-medium uppercase tracking-wide text-zinc-500";
export const tableHeadCellClass = "whitespace-nowrap px-3 py-2 font-medium";
export const tableHeadCellRightClass = `${tableHeadCellClass} text-right`;
export const tableRowClass = "border-b border-zinc-800/70 last:border-0 hover:bg-zinc-800/30";
export const tableCellClass = "px-3 py-2.5 align-top text-zinc-200";
export const tableCellRightClass = `${tableCellClass} text-right tabular-nums`;
export const tableCellMutedClass = "px-3 py-2.5 align-top text-xs text-zinc-500";

// Inline issue/warning/blocker treatments -- shown beside the field they
// concern, never collected into one giant detached banner.
export const inlineWarningClass = "rounded-lg border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200";
export const inlineErrorClass = "rounded-lg border border-red-800/70 bg-red-950/20 px-3 py-2 text-xs text-red-200";
export const inlineSuccessClass = "rounded-lg border border-emerald-800/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200";
export const inlineNeutralClass = "rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400";

// Sticky bottom action bar -- ONE consistent pattern for "here is the
// primary thing to do next," never buried at the end of a long scroll.
export const stickyActionBarClass =
  "sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-lg sm:pr-44";

// Status dot + word -- never color alone (Part "no contradictory
// states"): every status pairs a small colored indicator with a plain
// word, e.g. <StatusDot tone="success" /> Ready.
export const STATUS_DOT_CLASS: Record<"success" | "warning" | "danger" | "neutral" | "info", string> = {
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
  neutral: "bg-zinc-500",
  info: "bg-sky-400",
};
