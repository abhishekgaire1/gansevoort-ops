/**
 * Shared "N items need attention" footer-summary behavior (Receiving UX
 * Interaction System pass) -- pairs with WorkflowFooter's contextLabel/
 * onContextClick and InlineValidationMessage's `id`. Never a substitute for
 * showing the actual reason at the actual row/field: this only formats a
 * short count and, on click, scrolls to and focuses the FIRST blocked
 * element so a blocked Continue click always leads somewhere concrete
 * instead of doing nothing.
 */
export interface BlockingIssue {
  /** The DOM id of the row/field this issue belongs to -- must match an
   * element actually rendered on the page (e.g. the row wrapper). */
  id: string;
  description?: string | null;
  reason: string;
}

export function blockingIssueSummaryLabel(count: number, noun = "item"): string {
  if (count <= 0) return "";
  return `${count} ${noun}${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention`;
}

/** Scrolls to and focuses the first issue's element -- a no-op if the list
 * is empty or the element isn't currently rendered (e.g. it's on a
 * collapsed/hidden step). */
export function scrollToFirstIssue(issues: BlockingIssue[]): void {
  const first = issues[0];
  if (!first) return;
  const el = document.getElementById(first.id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusable = el.querySelector<HTMLElement>("input, select, textarea, button");
  focusable?.focus();
}
