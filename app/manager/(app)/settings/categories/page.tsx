import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { listInventoryCategories, listSpendCategories } from "@/app/actions/itemMaster";
import { CategorySettingsManager } from "./_components/CategorySettingsManager";

/**
 * The minimal category administration surface -- the canonical taxonomy
 * (scripts/seed-canonical-categories.ts) is a starting point, not
 * permanently closed. Deliberately simple: list/create/rename/activate
 * per plan -- no drag/drop, no destructive deletion (a category ever
 * referenced by an item or a classification snapshot must remain
 * resolvable in history), no chart-of-accounts tooling. Inline "+ Create
 * Category" inside the New Item Review modal (ItemClassificationForms.tsx)
 * is unchanged and remains the fast path during actual item review; this
 * page is for the slower, deliberate cleanup/setup pass.
 */
export const dynamic = "force-dynamic";

export default async function CategorySettingsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const [inventoryResult, spendResult] = await Promise.all([
    listInventoryCategories({ includeInactive: true }),
    listSpendCategories({ includeInactive: true }),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Categories</h1>
      <p className="mt-1 text-sm text-zinc-400">Manage the canonical inventory and spend category taxonomy.</p>
      <CategorySettingsManager
        initialInventoryCategories={inventoryResult.ok ? inventoryResult.categories : []}
        initialSpendCategories={spendResult.ok ? spendResult.categories : []}
      />
    </div>
  );
}
