/**
 * One shared status-badge visual system (Manager UX & Navigation
 * Milestone, Part 16) -- every module maps its OWN status vocabulary to
 * one of these tones rather than inventing its own badge styling.
 * Canonical database status values are never changed by this mapping;
 * it is presentation-only.
 */
export type StatusTone = "neutral" | "info" | "warning" | "success" | "danger";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-zinc-800 text-zinc-400",
  info: "bg-sky-950 text-sky-400",
  warning: "bg-amber-950 text-amber-400",
  success: "bg-emerald-950 text-emerald-400",
  danger: "bg-red-950 text-red-400",
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${TONE_CLASS[tone]}`}>
      {label}
    </span>
  );
}
