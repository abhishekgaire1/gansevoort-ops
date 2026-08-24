import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getManagerInventoryCategory, listManagerInventoryCategoryItems } from "@/app/lib/categories/managerInventoryCategories";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { InventoryCategoryItemList } from "./_components/InventoryCategoryItemList";

/**
 * Manager -> Categories -> Inventory -> [category] (Part 20-22). Reuses
 * the SAME authoritative balance/status logic every other inventory read
 * uses -- no category-level "total stock" number (Part 21/44: quantities
 * across PIECE/LB/GAL are never meaningfully summed). No inventory value
 * yet (Part 22) -- item names, current balances, stock states, location,
 * links to item detail only.
 */
export const dynamic = "force-dynamic";

export default async function ManagerInventoryCategoryDetailPage({ params }: { params: Promise<{ categoryId: string }> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { categoryId } = await params;
  const supabase = getServiceRoleClient();
  const category = await getManagerInventoryCategory(supabase, auth.manager.organizationId, categoryId);

  if (!category) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/categories" className={textLinkClass}>
          ← Categories
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Category not found.</p>
        </div>
      </div>
    );
  }

  const items = await listManagerInventoryCategoryItems(supabase, auth.manager.organizationId, categoryId);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/manager/categories" className={textLinkClass}>
        ← Categories
      </Link>

      <div className="mt-3 flex items-center gap-2">
        <h1 className="text-xl font-semibold text-zinc-100">{category.name}</h1>
        {!category.isActive ? <StatusBadge label="Inactive" tone="neutral" /> : null}
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {items.length} Inventory Item{items.length === 1 ? "" : "s"}
      </p>

      <div className="mt-5">
        <InventoryCategoryItemList items={items} />
      </div>
    </div>
  );
}
