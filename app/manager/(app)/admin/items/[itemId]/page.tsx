import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { getItemWorkspaceOverviewAction, listItemVendorPackagesAction, listItemHistoryAction } from "@/app/actions/adminItems";
import { listItemUsageUnitsAction } from "@/app/actions/itemUsageUnits";
import { listStorageEligibleLocations } from "@/app/lib/inventory/cycleCounts";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { AdminItemDetailView } from "./_components/AdminItemDetailView";

export const dynamic = "force-dynamic";

/**
 * Item workspace (redesigned, "Safe editing of confirmed items" feature)
 * -- Manager-or-Admin readable, full width. Managers can view everything
 * and make no-impact metadata edits; every inventory-affecting or
 * structural action (vendor package, usage unit, base unit, archive,
 * Adjust Inventory) stays Admin-only at the action layer regardless of
 * what's rendered here.
 */
export default async function AdminItemDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }
  const isAdmin = auth.manager.roles.includes("admin");

  const { itemId } = await params;
  const supabase = getServiceRoleClient();
  const [overviewResult, categoriesResult, unitsResult, packagesResult, usageUnitsResult, historyResult, storageLocations] = await Promise.all([
    getItemWorkspaceOverviewAction(itemId),
    listInventoryCategories(),
    supabase.from("units").select("id, code, name").order("name"),
    listItemVendorPackagesAction(itemId),
    listItemUsageUnitsAction(itemId),
    listItemHistoryAction(itemId),
    listStorageEligibleLocations(supabase, auth.manager.organizationId),
  ]);

  if (!overviewResult.ok) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/admin/items" className={textLinkClass}>
          ← Items
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Item not found.</p>
        </div>
      </div>
    );
  }

  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));
  const packages = packagesResult.ok ? packagesResult.packages : [];
  const usageUnits = usageUnitsResult.ok ? usageUnitsResult.units : [];
  const history = historyResult.ok ? historyResult.entries : [];
  const locations = storageLocations.map((l) => ({ locationId: l.id, locationName: l.name }));

  return (
    <div className="mx-auto max-w-6xl">
      <AdminItemDetailView
        overview={overviewResult.overview}
        categories={categories}
        units={units}
        packages={packages}
        usageUnits={usageUnits}
        history={history}
        locations={locations}
        isAdmin={isAdmin}
      />
    </div>
  );
}
