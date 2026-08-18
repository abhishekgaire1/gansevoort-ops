import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listUnresolvedClassificationsForReview } from "@/app/actions/itemClassification";
import { listInventoryItems, listInventoryCategories, listSpendCategories, listUnits } from "@/app/actions/itemMaster";
import { ReviewQueueManager } from "./_components/ReviewQueueManager";

/**
 * Recovery queue for CURRENT PENDING_REVIEW/STALE classifications across
 * every purchase document -- for a manager who left an unfinished invoice
 * mid-review and is coming back to it later, without needing to remember
 * which document it was on. Uses the exact same approve/override/new-item
 * RPCs as ItemMappingPanel (see ItemClassificationForms.tsx) -- this page
 * is a different entry point into the same authoritative backend logic,
 * never a parallel one.
 */
export const dynamic = "force-dynamic";

export default async function ItemsReviewPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const [linesResult, itemsResult, categoriesResult, spendResult, unitsResult] = await Promise.all([
    listUnresolvedClassificationsForReview(),
    listInventoryItems(),
    listInventoryCategories(),
    listSpendCategories(),
    listUnits(),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Item Review Queue</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Every line, across every purchase document, still needing a classification decision -- either never resolved (
        <span className="text-amber-300">Needs review</span>) or invalidated by a later correction (<span className="text-orange-300">Needs re-check</span>
        ). Resolved lines and orphaned historical rows are never shown here.
      </p>
      <ReviewQueueManager
        initialLines={linesResult.ok ? linesResult.lines : []}
        items={itemsResult.ok ? itemsResult.items : []}
        categories={categoriesResult.ok ? categoriesResult.categories : []}
        spendCategories={spendResult.ok ? spendResult.categories : []}
        units={unitsResult.ok ? unitsResult.units : []}
      />
    </div>
  );
}
