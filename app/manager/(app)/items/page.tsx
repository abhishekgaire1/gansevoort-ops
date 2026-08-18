import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listInventoryItems } from "@/app/actions/itemMaster";
import { listUnresolvedClassificationsForReview } from "@/app/actions/itemClassification";
import { ItemsManager } from "./_components/ItemsManager";

/**
 * The Item Master browse view -- CONFIRMED entries plus any PENDING_REVIEW
 * AI proposal still awaiting a manager decision. Approval happens either
 * from the purchase document line that produced the proposal
 * (ItemMappingPanel) or from the cross-document recovery queue below
 * (/manager/items/review) -- this page itself is read-only browse/search,
 * not a third approval surface.
 */
export const dynamic = "force-dynamic";

export default async function ItemsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const [result, reviewResult] = await Promise.all([listInventoryItems({ includePendingReview: true }), listUnresolvedClassificationsForReview()]);
  const items = result.ok ? result.items : [];
  const unresolvedCount = reviewResult.ok ? reviewResult.lines.length : 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Items</h1>
          <p className="mt-1 text-sm text-zinc-400">
            The canonical Item Master. AI-proposed items awaiting review are shown with a &ldquo;Needs review&rdquo; badge -- approve or reject them from
            the purchase document line that produced the proposal, or from the review queue.
          </p>
        </div>
        <Link
          href="/manager/items/review"
          className="shrink-0 rounded-full border border-amber-700 px-4 py-1.5 text-xs font-semibold text-amber-300"
        >
          Review Queue{unresolvedCount > 0 ? ` (${unresolvedCount})` : ""}
        </Link>
      </div>
      <ItemsManager initialItems={items} />
    </div>
  );
}
