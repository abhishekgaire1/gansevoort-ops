import Link from "next/link";
import type { InventoryItemLocationSummary, InventoryItemActivityPage } from "@/app/lib/inventory/itemActivity";
import type { InventoryItemOverviewExtras, InventoryItemUsageData } from "@/app/actions/inventoryItemActivity";
import type { UsagePeriod } from "@/app/lib/inventory/usagePeriods";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { OverviewTab } from "./OverviewTab";
import { ActivityTab } from "./ActivityTab";
import { UsageTab } from "./UsageTab";

export type ItemDetailTab = "overview" | "activity" | "usage";

const TABS: { key: ItemDetailTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "activity", label: "Activity" },
  { key: "usage", label: "Usage" },
];

/**
 * Inventory Item Detail shell (Inventory Item Detail Overview + Usage
 * milestone) -- header + [ Overview ][ Activity ][ Usage ] tabs, deep-
 * linkable via ?tab= (Part 3). Each tab needs fundamentally different
 * data (a stock summary vs. a paginated event timeline vs. aggregated
 * usage), so switching tabs is a real navigation (a plain <Link>
 * updating ?tab=), not client-side state -- page.tsx re-fetches only
 * what the newly-selected tab needs, and refresh/bookmark/back-forward
 * all naturally preserve the selected tab because it IS the URL.
 */
export function ItemDetailView({
  itemId,
  locationId,
  activeTab,
  summary,
  overviewExtras,
  activity,
  usage,
  usagePeriod,
}: {
  itemId: string;
  locationId: string;
  activeTab: ItemDetailTab;
  summary: InventoryItemLocationSummary;
  overviewExtras: InventoryItemOverviewExtras | null;
  activity: InventoryItemActivityPage | null;
  usage: InventoryItemUsageData | null;
  usagePeriod: UsagePeriod;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/inventory" className={textLinkClass}>
        ← Current Inventory
      </Link>

      <div>
        <h1 className="mt-1 text-xl font-semibold text-zinc-100">{summary.itemName}</h1>
        <p className="mt-1 text-sm text-zinc-500">{summary.locationName}</p>
      </div>

      <div className="flex gap-1 border-b border-zinc-800">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/manager/inventory/items/${itemId}?location=${locationId}&tab=${tab.key}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key ? "border-amber-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {activeTab === "overview" && overviewExtras ? (
        <OverviewTab summary={summary} lastReceived={overviewExtras.lastReceived} usageTotals={overviewExtras.usageTotals} />
      ) : null}

      {activeTab === "activity" && activity ? (
        <ActivityTab itemId={itemId} locationId={locationId} locationName={summary.locationName} initialActivity={activity} />
      ) : null}

      {activeTab === "usage" && usage ? (
        <UsageTab itemId={itemId} locationId={locationId} locationTimezone={summary.locationTimezone} initialPeriod={usagePeriod} initialUsage={usage} />
      ) : null}
    </div>
  );
}
