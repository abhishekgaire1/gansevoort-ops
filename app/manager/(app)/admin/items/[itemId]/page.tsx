import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAdminItem } from "@/app/lib/admin/items";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { listItemVendorMappingsAction } from "@/app/actions/adminItems";
import { listItemUsageUnitsAction } from "@/app/actions/itemUsageUnits";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { AdminItemDetailView } from "./_components/AdminItemDetailView";

export const dynamic = "force-dynamic";

export default async function AdminItemDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { itemId } = await params;
  const supabase = getServiceRoleClient();
  const [item, categoriesResult, unitsResult, mappingsResult, usageUnitsResult] = await Promise.all([
    getAdminItem(supabase, auth.manager.organizationId, itemId),
    listInventoryCategories(),
    supabase.from("units").select("id, code, name").order("name"),
    listItemVendorMappingsAction(itemId),
    listItemUsageUnitsAction(itemId),
  ]);

  if (!item) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/admin/items" className={textLinkClass}>
          ← Item Master
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Item not found.</p>
        </div>
      </div>
    );
  }

  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));
  const mappings = mappingsResult.ok ? mappingsResult.mappings : [];
  const usageUnits = usageUnitsResult.ok ? usageUnitsResult.units : [];

  return (
    <div className="mx-auto max-w-2xl">
      <AdminItemDetailView item={item} categories={categories} units={units} mappings={mappings} usageUnits={usageUnits} />
    </div>
  );
}
