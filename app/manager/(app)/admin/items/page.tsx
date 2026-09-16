import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminItems } from "@/app/lib/admin/items";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { listUnresolvedClassificationsForReview } from "@/app/actions/itemClassification";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { AdminItemsView } from "./_components/AdminItemsView";
import { AddItemButton } from "./_components/AddItemButton";

/**
 * Item Master (the single canonical items surface) -- full-width desktop
 * list, full capability for every Manager or Admin (2026-09-16 product
 * decision: the Item Master is not an Admin-only configuration area).
 * Every action is still independently re-gated server-side regardless of
 * what's rendered.
 */
export const dynamic = "force-dynamic";

export default async function AdminItemsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const [items, categoriesResult, unitsResult, reviewResult] = await Promise.all([
    listAdminItems(supabase, { organizationId: auth.manager.organizationId }),
    listInventoryCategories(),
    supabase.from("units").select("id, code, name").order("name"),
    listUnresolvedClassificationsForReview(),
  ]);
  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));
  const unresolvedCount = reviewResult.ok ? reviewResult.lines.length : 0;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Item Master"
        description="Maintain the canonical inventory catalog used across purchasing and receiving."
        action={
          <div className="flex gap-3">
            <Link href="/manager/items/review" className={secondaryButtonClass}>
              Review Queue{unresolvedCount > 0 ? ` (${unresolvedCount})` : ""}
            </Link>
            <Link href="/manager/admin/items/import" className={secondaryButtonClass}>
              Bulk Import
            </Link>
            <AddItemButton categories={categories} units={units} />
          </div>
        }
      />
      <AdminItemsView initialItems={items} categories={categories} units={units} />
    </div>
  );
}
