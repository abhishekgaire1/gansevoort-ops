import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listInventoryItems } from "@/app/actions/itemMaster";
import { listUnresolvedClassificationsForReview } from "@/app/actions/itemClassification";
import { ItemsManager } from "./_components/ItemsManager";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

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
      <PageHeader
        title="Items"
        description="The canonical Item Master. AI-proposed items awaiting review show a “Needs review” badge -- approve or reject them from the purchase document line that produced the proposal, or from the review queue."
        action={
          <Link href="/manager/items/review" className={secondaryButtonClass}>
            Review Queue{unresolvedCount > 0 ? ` (${unresolvedCount})` : ""}
          </Link>
        }
      />
      <ItemsManager initialItems={items} />
    </div>
  );
}
