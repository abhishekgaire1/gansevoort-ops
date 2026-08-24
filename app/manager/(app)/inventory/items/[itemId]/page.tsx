import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getInventoryItemLocationSummary, listInventoryItemActivity } from "@/app/lib/inventory/itemActivity";
import { getInventoryItemLastReceived, getInventoryItemUsageTotals } from "@/app/lib/inventory/itemOverview";
import { getInventoryItemUsageByStation, getInventoryItemUsageTrend } from "@/app/lib/inventory/itemUsage";
import { ItemDetailView, type ItemDetailTab } from "./_components/ItemDetailView";
import { textLinkClass } from "@/app/components/manager/buttonStyles";

/**
 * Inventory Item Detail (Inventory Item Detail Overview + Usage
 * milestone) -- a child of Current Inventory (/manager/inventory), not a
 * new sidebar module. The same canonical item can exist at more than one
 * storage location, so the URL must carry BOTH identifiers to keep
 * "Current Stock" unambiguous across refresh/direct navigation/
 * bookmarking -- ?location= is required, never inferred or defaulted
 * (Part 4/10). ?tab= selects Overview/Activity/Usage (Part 3), default
 * Overview, deep-linkable and refresh-preserving because it IS the URL.
 *
 * Each tab fetches ONLY the data it needs, server-side, so the initial
 * render for whichever tab is active never flashes a 0/empty state
 * before the real data loads (Part 33) -- only subsequent client
 * interactions (Activity's filter/Load More, Usage's period switch) go
 * through a client-side server action.
 */
export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tabFromParam(value: string | undefined): ItemDetailTab {
  if (value === "activity" || value === "usage") return value;
  return "overview";
}

export default async function InventoryItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // The (app) layout above already redirects unauthenticated/unauthorized
    // requests before this ever renders; this is a defensive fallback only.
    return null;
  }

  const { itemId } = await params;
  const sp = await searchParams;
  const locationId = firstValue(sp.location);
  const tab = tabFromParam(firstValue(sp.tab));

  if (!locationId) {
    return <NotFoundState />;
  }

  const supabase = getServiceRoleClient();
  const summary = await getInventoryItemLocationSummary(supabase, auth.manager.organizationId, itemId, locationId);
  if (!summary) {
    return <NotFoundState />;
  }

  const overviewExtras =
    tab === "overview"
      ? await Promise.all([
          getInventoryItemLastReceived(supabase, auth.manager.organizationId, itemId, locationId),
          getInventoryItemUsageTotals(supabase, auth.manager.organizationId, itemId, locationId),
        ]).then(([lastReceived, usageTotals]) => ({ lastReceived, usageTotals }))
      : null;

  const activity =
    tab === "activity"
      ? await listInventoryItemActivity(supabase, { organizationId: auth.manager.organizationId, inventoryItemId: itemId, locationId, filter: "ALL" })
      : null;

  const usagePeriod = "THIRTY_DAYS" as const;
  const usage =
    tab === "usage"
      ? await Promise.all([
          getInventoryItemUsageByStation(supabase, auth.manager.organizationId, itemId, locationId, usagePeriod),
          getInventoryItemUsageTrend(supabase, auth.manager.organizationId, itemId, locationId, usagePeriod),
        ]).then(([byStation, trend]) => ({ byStation, trend }))
      : null;

  return (
    <div className="mx-auto max-w-4xl">
      <ItemDetailView
        itemId={itemId}
        locationId={locationId}
        activeTab={tab}
        summary={summary}
        overviewExtras={overviewExtras}
        activity={activity}
        usage={usage}
        usagePeriod={usagePeriod}
      />
    </div>
  );
}

function NotFoundState() {
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/manager/inventory" className={textLinkClass}>
        ← Current Inventory
      </Link>
      <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="text-sm text-zinc-400">Inventory item not found.</p>
      </div>
    </div>
  );
}
