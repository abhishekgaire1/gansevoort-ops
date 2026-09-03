import type { WizardStepId } from "./deriveWizardProgress";

/** URL-backed step navigation (?step=invoice|items|review) -- lets a
 * refresh or the browser Back/Forward button land on the step the
 * manager was actually looking at, without a new persisted workflow-state
 * column: the query param is purely a navigation hint, re-validated on
 * every render against deriveWizardProgress's own furthest-reachable
 * clamp, so it can never be used to skip ahead of genuinely incomplete
 * work.
 *
 * Redesign: the old 4-step wizard's "receiving" slug (step 3) now maps to
 * "items" (the combined step) -- an old bookmarked/shared link with
 * ?step=receiving still lands the manager on the right step instead of a
 * cold step-1 restart. */
export const WIZARD_STEP_SLUGS: Record<WizardStepId, string> = {
  1: "invoice",
  2: "items",
  3: "review",
};

/** Slugs from the previous 4-step wizard that now redirect to a current
 * step -- kept only for backward compatibility with old links/bookmarks. */
const LEGACY_SLUG_REDIRECTS: Record<string, WizardStepId> = {
  receiving: 2,
};

export function wizardStepFromSlug(slug: string | null): WizardStepId | null {
  if (!slug) return null;
  const entry = Object.entries(WIZARD_STEP_SLUGS).find(([, s]) => s === slug);
  if (entry) return Number(entry[0]) as WizardStepId;
  return LEGACY_SLUG_REDIRECTS[slug] ?? null;
}
