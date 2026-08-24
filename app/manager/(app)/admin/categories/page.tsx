import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { listInventoryCategories, listSpendCategories } from "@/app/actions/itemMaster";
import { CategoryAdminManager } from "./_components/CategoryAdminManager";
import { PageHeader } from "@/app/components/manager/PageHeader";

/**
 * Admin -> Categories (Admin Master Data milestone, Part 20-23) -- ONE
 * page with internal Inventory/Spend tabs, not two sidebar entries.
 * Category creation is Admin-only (Part 23): server-enforces
 * requireAdmin() itself, so a Manager hitting this route directly is
 * redirected. Managers still SELECT approved categories elsewhere
 * (Receiving new-item review) -- they just can no longer create them.
 */
export const dynamic = "force-dynamic";

export default async function AdminCategoriesPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const [inventoryResult, spendResult] = await Promise.all([
    listInventoryCategories({ includeInactive: true }),
    listSpendCategories({ includeInactive: true }),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Categories" description="Manage approved classifications used by inventory and expenses." />
      <CategoryAdminManager
        initialInventoryCategories={inventoryResult.ok ? inventoryResult.categories : []}
        initialSpendCategories={spendResult.ok ? spendResult.categories : []}
      />
    </div>
  );
}
