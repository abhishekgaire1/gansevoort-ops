import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminItems } from "@/app/lib/admin/items";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { AdminItemsView } from "./_components/AdminItemsView";
import { AddItemButton } from "./_components/AddItemButton";

/**
 * Items (redesigned, "Safe editing of confirmed items" feature) -- full-
 * width desktop list, Manager-or-Admin readable (a plain Manager needs to
 * browse and open the workspace to make no-impact metadata edits, per
 * the tiered-permissions decision). Create/Bulk Import stay Admin-only
 * structural actions -- hidden from a plain Manager's view here, and
 * still independently re-gated server-side by their own actions
 * regardless of what's rendered.
 */
export const dynamic = "force-dynamic";

export default async function AdminItemsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }
  const isAdmin = auth.manager.roles.includes("admin");

  const supabase = getServiceRoleClient();
  const [items, categoriesResult, unitsResult] = await Promise.all([
    listAdminItems(supabase, { organizationId: auth.manager.organizationId }),
    listInventoryCategories(),
    supabase.from("units").select("id, code, name").order("name"),
  ]);
  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Items"
        description="Maintain the canonical inventory catalog used across purchasing and receiving."
        action={
          isAdmin ? (
            <div className="flex gap-3">
              <Link href="/manager/admin/items/import" className={secondaryButtonClass}>
                Bulk Import
              </Link>
              <AddItemButton categories={categories} units={units} />
            </div>
          ) : undefined
        }
      />
      <AdminItemsView initialItems={items} categories={categories} units={units} />
    </div>
  );
}
