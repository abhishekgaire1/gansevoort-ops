import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminItems } from "@/app/lib/admin/items";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { AdminItemsView } from "./_components/AdminItemsView";
import { AddItemButton } from "./_components/AddItemButton";

/**
 * Admin -> Item Master (Canonical Item Master + Inventory Relevance
 * Classification milestone, Part 7/8) -- a child of the Admin sidebar
 * group, deliberately NOT under Current Inventory: this is organization
 * master data, not an operational inventory view. Server-enforces
 * requireAdmin() itself (Part 56) -- a Manager hitting this route
 * directly is redirected, never merely hidden from the sidebar.
 */
export const dynamic = "force-dynamic";

export default async function AdminItemsPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const [items, categoriesResult, unitsResult] = await Promise.all([
    listAdminItems(supabase, { organizationId: auth.manager.organizationId }),
    listInventoryCategories(),
    supabase.from("units").select("id, code, name").order("name"),
  ]);
  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Item Master"
        description="Manage the canonical inventory catalog used across purchasing and receiving."
        action={
          <div className="flex gap-3">
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
