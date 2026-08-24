import { PageHeader } from "@/app/components/manager/PageHeader";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listInventoryActivity } from "@/app/lib/inventory/globalActivity";
import { listStorageEligibleLocations } from "@/app/lib/inventory/cycleCounts";
import { InventoryActivityView } from "./_components/InventoryActivityView";

/**
 * Global Inventory Activity (Global Inventory Activity milestone) -- "what
 * has been happening to our inventory," across every item/location/
 * station, distinct from Current Inventory's "what do we have right now."
 * A child of Inventory in the sidebar (Part 1), not a new top-level
 * module. The first, unfiltered page is fetched here, server-side, so the
 * initial render never flashes an empty feed (same convention as the
 * item-detail Activity page).
 */
export const dynamic = "force-dynamic";

export default async function InventoryActivityPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // The (app) layout above already redirects unauthenticated/unauthorized
    // requests before this ever renders; this is a defensive fallback only.
    return null;
  }

  const supabase = getServiceRoleClient();
  const [initialPage, locations] = await Promise.all([
    listInventoryActivity(supabase, { organizationId: auth.manager.organizationId }),
    listStorageEligibleLocations(supabase, auth.manager.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Inventory Activity" description="Track inventory movement across storage locations and stations." />
      <InventoryActivityView initialPage={initialPage} locations={locations} />
    </div>
  );
}
