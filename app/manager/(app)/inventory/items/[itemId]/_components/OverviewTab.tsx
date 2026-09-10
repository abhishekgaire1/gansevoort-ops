import Link from "next/link";
import type { InventoryItemLocationSummary } from "@/app/lib/inventory/itemActivity";
import type { InventoryItemLastReceived, InventoryItemUsageTotals } from "@/app/lib/inventory/itemOverview";
import type { LatestPurchasePrice } from "@/app/lib/inventory/priceHistory";
import { conversionLabel } from "@/app/lib/inventory/priceHistoryPresentation";
import { computeStockGauge, stockLevelTextClass } from "@/app/lib/inventory/stockLevel";
import { formatQuantityMagnitude, formatActivityTimestamp } from "../../../_lib/activityPresentation";
import { formatCurrency } from "../../../_lib/usagePresentation";
import { formatMoney } from "@/app/lib/formatMoney";

/**
 * Item Detail's Overview tab (Inventory Item Detail Overview + Usage
 * milestone) -- Current Stock/Full Level/Status (Part 5, the SAME
 * balance/status logic Current Inventory's cards use), Last Received
 * (Part 6), Latest Purchase Price (vendor-aware Price History feature --
 * HISTORICAL purchase pricing, deliberately never presented as
 * "Inventory Value": no authoritative stock-valuation basis exists in
 * this schema and none is invented here), and Recent Withdrawals (Part
 * 10). Server-rendered -- no client interactivity needed here, so no
 * loading flash is even possible (Part 33).
 */
export function OverviewTab({
  summary,
  lastReceived,
  usageTotals,
  latestPurchasePrice,
  itemId,
  locationId,
}: {
  summary: InventoryItemLocationSummary;
  lastReceived: InventoryItemLastReceived | null;
  usageTotals: InventoryItemUsageTotals;
  latestPurchasePrice: LatestPurchasePrice | null;
  itemId: string;
  locationId: string;
}) {
  const gauge = computeStockGauge(summary.balance, summary.fullReferenceQuantity);
  const now = new Date();

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current Stock</p>
          <p className="mt-1 text-lg font-semibold text-zinc-100">
            {formatQuantityMagnitude(summary.balance)} {summary.baseUnitCode}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Full Level</p>
          <p className="mt-1 text-lg font-semibold text-zinc-100">
            {summary.fullReferenceQuantity !== null ? `${formatQuantityMagnitude(summary.fullReferenceQuantity)} ${summary.baseUnitCode}` : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Status</p>
          <p className={`mt-1 text-lg font-semibold ${stockLevelTextClass(gauge.level)}`}>
            {gauge.percent !== null ? `${gauge.percent}%` : "—"} <span className="text-xs font-normal">{gauge.label}</span>
          </p>
        </div>
      </div>
      {summary.includesLegacyEstimate ? (
        <p className="-mt-2 text-[10px] text-zinc-600">Includes estimated allocation from legacy withdrawals</p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Last Received</p>
          {lastReceived ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="text-sm text-zinc-400">{formatActivityTimestamp(lastReceived.occurredAt, now)}</p>
              <p className="text-lg font-semibold text-emerald-400">
                +{formatQuantityMagnitude(lastReceived.quantity)} {lastReceived.baseUnitCode}
              </p>
              {lastReceived.vendor ? <p className="mt-1 text-sm text-zinc-300">{lastReceived.vendor.name}</p> : null}
              {lastReceived.purchaseDocument ? (
                <Link href={`/manager/purchases/${lastReceived.purchaseDocument.id}`} className="text-sm font-medium text-amber-400 hover:underline">
                  {lastReceived.purchaseDocument.documentNumber ? `Invoice #${lastReceived.purchaseDocument.documentNumber} →` : "View Document →"}
                </Link>
              ) : null}
              {lastReceived.unitCost !== null ? (
                <p className="mt-1 text-xs text-zinc-500">
                  Last Purchase Cost {formatCurrency(lastReceived.unitCost)} / {lastReceived.baseUnitCode}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No receiving history available.</p>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Latest Purchase Price</p>
          {latestPurchasePrice ? (
            <LatestPurchasePricePanel data={latestPurchasePrice} itemId={itemId} locationId={locationId} />
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No eligible purchase history yet.</p>
          )}
        </div>
      </div>

      <p className="-mt-2 text-[10px] text-zinc-600">
        Historical purchase prices are shown for operational comparison. They are not an accounting inventory valuation.
      </p>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent Withdrawals</p>
        <div className="mt-2 flex flex-col divide-y divide-zinc-800">
          <RecentWithdrawalRow label="Today" quantity={usageTotals.today} unit={usageTotals.baseUnitCode} />
          <RecentWithdrawalRow label="7 Days" quantity={usageTotals.sevenDay} unit={usageTotals.baseUnitCode} />
          <RecentWithdrawalRow label="30 Days" quantity={usageTotals.thirtyDay} unit={usageTotals.baseUnitCode} />
        </div>
      </div>
    </div>
  );
}

function LatestPurchasePricePanel({ data, itemId, locationId }: { data: LatestPurchasePrice; itemId: string; locationId: string }) {
  const { latest, previous, change } = data;
  // getLatestPurchasePriceForOverview only ever returns PRICED events;
  // this guard keeps the "never render $0.00 for an uncomputable price"
  // rule structurally airtight anyway.
  if (latest.normalizedPrice === null) return <p className="mt-2 text-sm text-zinc-500">No eligible purchase history yet.</p>;
  const receivedDate = new Date(latest.receivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return (
    <div className="mt-2 flex flex-col gap-1">
      <p className="text-lg font-semibold text-zinc-100">
        {formatMoney(latest.normalizedPrice, latest.currency)} <span className="text-xs font-normal text-zinc-400">/ {latest.baseUnitCode}</span>
      </p>
      <p className="text-sm text-zinc-300">{latest.vendorName ?? "Unknown vendor"}</p>
      {previous && previous.normalizedPrice !== null ? (
        <p className="text-xs text-zinc-500">
          Previous: {formatMoney(previous.normalizedPrice, previous.currency)} / {previous.baseUnitCode}
        </p>
      ) : null}
      {change ? (
        <p className={`text-xs ${change.dollarChange > 0 ? "text-amber-400" : change.dollarChange < 0 ? "text-emerald-400" : "text-zinc-500"}`}>
          Change: {change.dollarChange >= 0 ? "+" : "−"}
          {formatMoney(Math.abs(change.dollarChange), latest.currency)}
          {change.percentChange !== null ? ` · ${change.percentChange >= 0 ? "+" : "−"}${Math.abs(change.percentChange).toFixed(1)}%` : ""}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-zinc-500">
        Purchased as: {conversionLabel(latest)}
      </p>
      <p className="text-xs text-zinc-500">
        <Link href={`/manager/purchases/${latest.currentRevisionId}`} className="font-medium text-amber-400 hover:underline">
          {latest.documentNumber ? `Invoice #${latest.documentNumber}` : "View Document"}
        </Link>{" "}
        · {receivedDate}
        {latest.isAmended ? <span className="ml-1 text-amber-400">· Amended</span> : null}
      </p>
      <Link
        href={`/manager/inventory/items/${itemId}?location=${locationId}&tab=price-history`}
        className="mt-1 text-sm font-medium text-amber-400 hover:underline"
      >
        View Price History →
      </Link>
    </div>
  );
}

function RecentWithdrawalRow({ label, quantity, unit }: { label: string; quantity: number; unit: string }) {
  return (
    <div className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
      <span className="text-sm text-zinc-400">{label}</span>
      <span className="text-sm font-medium text-zinc-100">
        {formatQuantityMagnitude(quantity)} {unit}
      </span>
    </div>
  );
}
