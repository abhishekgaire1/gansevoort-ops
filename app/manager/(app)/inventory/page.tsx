import Link from "next/link";
import { InventoryBalancesView } from "./_components/InventoryBalancesView";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listCycleCountDraftStatus } from "@/app/actions/cycleCounts";
import { PageHeader } from "@/app/components/manager/PageHeader";

/**
 * The Inventory home (Navigation Cleanup Milestone) -- an optional real
 * "Needs Attention" note, then the Item + Location balance grid. Every
 * number in that grid derives from the append-only inventory ledger
 * (list_inventory_balances) -- there is no separately-editable "current
 * quantity" anywhere. The full-stock reference (the 100% denominator) is
 * a visualization baseline only, reset automatically by each genuine
 * restock and overridable by a manager -- never ledger truth.
 *
 * Cycle Counts (physical reconciliation) and Inventory Waste (known loss
 * from physical storage) are both genuine ledger-writing workflows, kept
 * as their own routes. They represent different business facts (Inventory
 * Waste = we KNOW what happened; Cycle Count variance = physical differs
 * from ledger and the remainder is unexplained) and are never merged.
 * Both are reached from the persistent sidebar under Inventory rather than
 * from Quick Actions on this page, so this page can stay focused on
 * current stock.
 */
export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const auth = await requireManagerOrAdmin();
  const draftsResult = auth.ok ? await listCycleCountDraftStatus() : null;
  const ownDraftCount = draftsResult?.ok ? draftsResult.drafts.filter((d) => d.isOwnedByCurrentManager).length : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Inventory" description="View and manage current stock across storage locations." />

      {/* Only ever a real, actionable state -- never a fabricated
       * analytics/exception item (Part 4/11). */}
      {ownDraftCount > 0 ? (
        <Link
          href="/manager/inventory/cycle-count"
          className="mt-4 flex items-center justify-between rounded-2xl border border-amber-800/40 bg-zinc-900 p-3 hover:border-amber-400/40"
        >
          <span className="text-sm text-zinc-200">
            {ownDraftCount} cycle count{ownDraftCount === 1 ? "" : "s"} in progress
          </span>
          <span className="text-sm font-medium text-amber-400">Resume →</span>
        </Link>
      ) : null}

      <div className="mt-6">
        <InventoryBalancesView />
      </div>
    </div>
  );
}
