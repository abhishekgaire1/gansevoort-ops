"use client";

import { useState } from "react";
import Link from "next/link";
import type { ItemWorkspaceOverview } from "@/app/lib/admin/itemWorkspace";
import type { CategorySummary } from "@/app/actions/itemMaster";
import type { VendorPackageSummary } from "@/app/lib/admin/vendorPackages";
import type { ItemUsageUnitSummary } from "@/app/actions/itemUsageUnits";
import type { ItemHistoryEntry } from "@/app/lib/admin/itemHistory";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { textLinkClass, primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";
import { ItemOverviewSection } from "./ItemOverviewSection";
import { PurchasePackagesSection } from "./PurchasePackagesSection";
import { EmployeeWithdrawalOptionsSection } from "./EmployeeWithdrawalOptionsSection";
import { InventorySettingsSection } from "./InventorySettingsSection";
import { ItemHistorySection } from "./ItemHistorySection";
import { EditItemDialog } from "./EditItemDialog";
import { ArchiveItemDialog } from "./ArchiveItemDialog";
import { AdjustInventoryDialog } from "./AdjustInventoryDialog";

/**
 * Item workspace orchestrator (spec sections 3-6) -- Overview, Purchase
 * Packages, Employee Withdrawal Options, Inventory Settings, and History
 * sections, plus the Edit Item / Archive / Adjust Inventory actions.
 * "Confirmed" is no longer a dead-end status: every section here is a
 * real, impact-appropriate editing surface, not a read-only summary.
 */
export function AdminItemDetailView({
  overview,
  categories,
  units,
  packages,
  usageUnits,
  history,
  locations,
}: {
  overview: ItemWorkspaceOverview;
  categories: CategorySummary[];
  units: { id: string; code: string; name: string }[];
  packages: VendorPackageSummary[];
  usageUnits: ItemUsageUnitSummary[];
  history: ItemHistoryEntry[];
  locations: { locationId: string; locationName: string }[];
}) {
  const { item } = overview;
  const isActive = item.status === "active";
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const lastEntry = history[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/admin/items" className={textLinkClass}>
        ← Items
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-zinc-500">{item.itemNumber}</p>
          <h1 className="text-xl font-semibold text-zinc-100">{item.name}</h1>
          <div className="mt-1">
            <StatusBadge label={isActive ? "Active" : "Archived"} tone={isActive ? "success" : "neutral"} />
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setEditOpen(true)} className={secondaryButtonClass}>
            Edit Item
          </button>
          <button type="button" onClick={() => setAdjustOpen(true)} className={secondaryButtonClass}>
            Adjust Inventory
          </button>
          <button type="button" onClick={() => setArchiveOpen(true)} className={isActive ? destructiveButtonClass : primaryButtonClass}>
            {isActive ? "Archive Item" : "Reactivate Item"}
          </button>
        </div>
      </div>

      <ItemOverviewSection overview={overview} actorSummary={lastEntry?.actorName ?? null} />
      <PurchasePackagesSection packages={packages} canEdit baseUnitCode={item.baseUnitCode ?? ""} />
      {item.baseUnitId !== null ? <EmployeeWithdrawalOptionsSection itemId={item.itemId} units={units} usageUnits={usageUnits} canEdit /> : null}
      <InventorySettingsSection item={item} units={units} canEditBaseUnit />
      <ItemHistorySection entries={history} />

      {editOpen ? <EditItemDialog item={item} categories={categories} onClose={() => setEditOpen(false)} /> : null}
      {archiveOpen ? <ArchiveItemDialog itemId={item.itemId} itemName={item.name} status={item.status} onClose={() => setArchiveOpen(false)} /> : null}
      {adjustOpen ? <AdjustInventoryDialog itemId={item.itemId} baseUnitCode={item.baseUnitCode ?? ""} locations={locations} onClose={() => setAdjustOpen(false)} /> : null}
    </div>
  );
}
