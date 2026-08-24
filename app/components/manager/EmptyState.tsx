import type { ReactNode } from "react";

/**
 * One shared empty-state shape (Manager UX & Navigation Milestone, Part
 * 19) -- a short message plus an optional single action, never a bare
 * unexplained blank area.
 */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
      <p className="text-sm text-zinc-500">{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
