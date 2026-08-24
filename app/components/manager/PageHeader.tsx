import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Standard manager page header (Manager UX & Navigation Milestone, Part
 * 13): title + short description on the left, at most ONE primary
 * action on the right, an optional back link above the title. Every
 * manager page should use this instead of hand-rolling its own header
 * markup, so title size/spacing/back-nav placement stop varying module
 * to module.
 */
export function PageHeader({
  title,
  description,
  backHref,
  backLabel,
  action,
}: {
  title: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {backHref ? (
          <Link href={backHref} className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            {backLabel ?? "← Back"}
          </Link>
        ) : null}
        <h1 className={`text-xl font-semibold text-zinc-100 ${backHref ? "mt-1" : ""}`}>{title}</h1>
        {description ? <p className="mt-1 text-sm text-zinc-500">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
