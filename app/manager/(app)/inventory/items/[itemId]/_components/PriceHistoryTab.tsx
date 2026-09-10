"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getItemPriceHistoryAction, type ItemPriceHistoryData } from "@/app/actions/inventoryItemActivity";
import type { PriceHistoryEvent, PriceHistoryCursor, VendorPriceSummary } from "@/app/lib/inventory/priceHistory";
import {
  PRICE_HISTORY_PERIODS,
  computePriceChange,
  conversionLabel,
  priceUnavailableCopy,
  type PriceHistoryPeriod,
} from "@/app/lib/inventory/priceHistoryPresentation";
import { formatMoney } from "@/app/lib/formatMoney";
import { formatQuantityMagnitude } from "../../../_lib/activityPresentation";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import {
  panelClass,
  panelHeaderClass,
  panelTitleClass,
  panelMetaClass,
  selectClass,
  labelClass,
  tableWrapClass,
  tableClass,
  tableHeadClass,
  tableHeadCellClass,
  tableHeadCellRightClass,
  tableRowClass,
  tableCellClass,
  tableCellRightClass,
  tableCellMutedClass,
  inlineNeutralClass,
  inlineWarningClass,
} from "@/app/components/manager/surfaces";
import { PriceHistoryChart } from "./PriceHistoryChart";

/**
 * Price History tab (vendor-aware Price History feature) -- read-only
 * HISTORICAL purchase pricing for one inventory item: summary strip,
 * vendor/period filters (reflected in the URL per the manager-app
 * convention), a compact SVG chart, the authoritative purchase table,
 * and Vendor Comparison. Never an inventory valuation, and never a
 * write path of any kind. The table is item-wide (not per-location):
 * an invoice line's price is a line-level fact, and one line can post
 * to several locations, so per-location price attribution would be
 * fabricated.
 */

export function PriceHistoryTab({
  itemId,
  locationId,
  baseUnitCode,
  initialData,
  initialPeriod,
  initialVendorId,
}: {
  itemId: string;
  locationId: string;
  baseUnitCode: string;
  initialData: ItemPriceHistoryData;
  initialPeriod: PriceHistoryPeriod;
  initialVendorId: string | null;
}) {
  const router = useRouter();
  const [period, setPeriod] = useState<PriceHistoryPeriod>(initialPeriod);
  const [vendorId, setVendorId] = useState<string | null>(initialVendorId);
  const [summary, setSummary] = useState(initialData.summary);
  const [events, setEvents] = useState<PriceHistoryEvent[]>(initialData.page.events);
  const [cursor, setCursor] = useState<PriceHistoryCursor | null>(initialData.page.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCorrection, setExpandedCorrection] = useState<string | null>(null);

  // The unfiltered vendor list must stay stable while a vendor filter is
  // active (a filtered summary only contains the selected vendor).
  const [vendorOptions] = useState<VendorPriceSummary[]>(initialVendorId === null ? initialData.summary.vendors : []);

  const overall = summary.overall;
  const presentedCurrency = overall?.currency ?? "USD";

  async function applyFilters(nextVendorId: string | null, nextPeriod: PriceHistoryPeriod) {
    setVendorId(nextVendorId);
    setPeriod(nextPeriod);
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ location: locationId, tab: "price-history", period: nextPeriod });
    if (nextVendorId) params.set("vendor", nextVendorId);
    router.replace(`/manager/inventory/items/${itemId}?${params.toString()}`, { scroll: false });
    const result = await getItemPriceHistoryAction(itemId, { vendorId: nextVendorId, period: nextPeriod }, null);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load price history.");
      return;
    }
    setSummary(result.data.summary);
    setEvents(result.data.page.events);
    setCursor(result.data.page.nextCursor);
    setExpandedCorrection(null);
  }

  async function handleLoadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    const result = await getItemPriceHistoryAction(itemId, { vendorId, period }, cursor);
    setLoading(false);
    if (!result.ok) {
      setError("Unable to load price history.");
      return;
    }
    setEvents((prev) => [...prev, ...result.data.page.events]);
    setCursor(result.data.page.nextCursor);
  }

  const periodChange = overall ? computePriceChange(overall.latestPrice, overall.firstPrice) : null;
  const comparisonVendors = vendorId === null ? summary.vendors : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Summary strip */}
      <div className={`${panelClass} grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-6`}>
        <SummaryStat label="Latest Price" value={overall ? `${formatMoney(overall.latestPrice, presentedCurrency)} / ${baseUnitCode}` : "—"} />
        <SummaryStat label="Latest Vendor" value={overall?.vendorName ?? summaryLatestVendorName(summary.vendors, overall) ?? "—"} />
        <SummaryStat label="Lowest (period)" value={overall ? `${formatMoney(overall.lowestPrice, presentedCurrency)} / ${baseUnitCode}` : "—"} />
        <SummaryStat label="Highest (period)" value={overall ? `${formatMoney(overall.highestPrice, presentedCurrency)} / ${baseUnitCode}` : "—"} />
        <SummaryStat
          label="Change (period)"
          value={
            periodChange
              ? `${periodChange.dollarChange >= 0 ? "+" : "−"}${formatMoney(Math.abs(periodChange.dollarChange), presentedCurrency)}${
                  periodChange.percentChange !== null
                    ? ` · ${periodChange.percentChange >= 0 ? "+" : "−"}${Math.abs(periodChange.percentChange).toFixed(1)}%`
                    : ""
                }`
              : "—"
          }
          tone={periodChange ? (periodChange.dollarChange > 0 ? "up" : periodChange.dollarChange < 0 ? "down" : undefined) : undefined}
        />
        <SummaryStat label="Purchases" value={overall ? String(overall.eventCount) : "0"} />
      </div>

      {/* Filters */}
      <div className={`${panelClass} flex flex-wrap items-end gap-3 p-4`}>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Vendor
          <select
            value={vendorId ?? ""}
            onChange={(e) => void applyFilters(e.target.value || null, period)}
            className={`${selectClass} w-48`}
            disabled={loading}
          >
            <option value="">All vendors</option>
            {(vendorOptions.length > 0 ? vendorOptions : summary.vendors).map((v) =>
              v.vendorId ? (
                <option key={v.vendorId} value={v.vendorId}>
                  {v.vendorName ?? "Unknown vendor"}
                </option>
              ) : null
            )}
          </select>
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Period
          <select
            value={period}
            onChange={(e) => void applyFilters(vendorId, e.target.value as PriceHistoryPeriod)}
            className={`${selectClass} w-32`}
            disabled={loading}
          >
            {PRICE_HISTORY_PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {loading ? <span className="pb-2 text-xs text-zinc-500">Loading…</span> : null}
      </div>

      {error ? <div className={inlineWarningClass}>{error}</div> : null}

      {summary.otherCurrencyEventCount > 0 ? (
        <div className={inlineNeutralClass}>
          {summary.otherCurrencyEventCount} purchase{summary.otherCurrencyEventCount === 1 ? "" : "s"} in other currencies{" "}
          {summary.otherCurrencyEventCount === 1 ? "is" : "are"} listed in the table but excluded from the summary and chart — different
          currencies are never combined into one trend.
        </div>
      ) : null}

      {/* Chart */}
      <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>Price Trend</h2>
          <p className={panelMetaClass}>
            {presentedCurrency} per {baseUnitCode} · one series per vendor
          </p>
        </div>
        <div className="p-4">
          <PriceHistoryChart events={events} currency={presentedCurrency} />
        </div>
      </div>

      {/* Historical purchase table */}
      <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>Purchases</h2>
          <p className={panelMetaClass}>Newest first · authoritative record</p>
        </div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No eligible purchases in this selection.</p>
        ) : (
          <div className={tableWrapClass.replace("rounded-lg border border-zinc-800", "rounded-b-lg")}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Received</th>
                  <th className={tableHeadCellClass}>Vendor</th>
                  <th className={tableHeadCellClass}>SKU</th>
                  <th className={tableHeadCellClass}>Invoice</th>
                  <th className={tableHeadCellRightClass}>Invoice Qty</th>
                  <th className={tableHeadCellClass}>Conversion</th>
                  <th className={tableHeadCellRightClass}>Inventory Received</th>
                  <th className={tableHeadCellRightClass}>Line Amount</th>
                  <th className={tableHeadCellRightClass}>Normalized Price</th>
                  <th className={tableHeadCellRightClass}>Change</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => (
                  <PriceHistoryRow
                    key={`${event.purchaseDocumentId}:${event.lineKey}`}
                    event={event}
                    previous={previousPricedEvent(events, index)}
                    expanded={expandedCorrection === `${event.purchaseDocumentId}:${event.lineKey}`}
                    onToggleExpand={() =>
                      setExpandedCorrection((current) =>
                        current === `${event.purchaseDocumentId}:${event.lineKey}` ? null : `${event.purchaseDocumentId}:${event.lineKey}`
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <div className="border-t border-zinc-800 p-3">
            <button type="button" onClick={() => void handleLoadMore()} disabled={loading} className={secondaryButtonClass}>
              {loading ? "Loading…" : "Load More"}
            </button>
          </div>
        ) : null}
      </div>

      {/* Vendor comparison */}
      {comparisonVendors.length >= 2 ? (
        <div className={panelClass}>
          <div className={panelHeaderClass}>
            <h2 className={panelTitleClass}>Vendor Comparison</h2>
            <p className={panelMetaClass}>Selected period · {presentedCurrency}</p>
          </div>
          <div className={tableWrapClass.replace("rounded-lg border border-zinc-800", "rounded-b-lg")}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Vendor</th>
                  <th className={tableHeadCellRightClass}>Latest Price</th>
                  <th className={tableHeadCellClass}>Last Purchase</th>
                  <th className={tableHeadCellRightClass}>Purchases</th>
                  <th className={tableHeadCellRightClass}>Lowest</th>
                  <th className={tableHeadCellRightClass}>Highest</th>
                  <th className={tableHeadCellClass}>Latest Package</th>
                </tr>
              </thead>
              <tbody>
                {comparisonVendors.map((v) => (
                  <tr key={v.vendorId ?? "unknown"} className={tableRowClass}>
                    <td className={tableCellClass}>{v.vendorName ?? "Unknown vendor"}</td>
                    <td className={tableCellRightClass}>
                      {formatMoney(v.latestPrice, v.currency)} / {baseUnitCode}
                    </td>
                    <td className={tableCellMutedClass}>
                      {new Date(v.latestReceivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    <td className={tableCellRightClass}>{v.eventCount}</td>
                    <td className={tableCellRightClass}>{formatMoney(v.lowestPrice, v.currency)}</td>
                    <td className={tableCellRightClass}>{formatMoney(v.highestPrice, v.currency)}</td>
                    <td className={tableCellMutedClass}>{v.latestPackage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <p className="text-[10px] text-zinc-600">
        Historical purchase prices are shown for operational comparison. They are not an accounting inventory valuation. Normalized prices
        reflect line amounts only — freight, delivery charges, invoice-level discounts, tax, and other fees are not allocated to items.
      </p>
    </div>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${tone === "up" ? "text-amber-400" : tone === "down" ? "text-emerald-400" : "text-zinc-100"}`}>
        {value}
      </p>
    </div>
  );
}

function summaryLatestVendorName(vendors: VendorPriceSummary[], overall: VendorPriceSummary | null): string | null {
  if (!overall) return null;
  const latest = vendors.find((v) => v.latestReceivedAt === overall.latestReceivedAt);
  return latest?.vendorName ?? null;
}

/** The chronologically-previous PRICED event in the SAME currency --
 * the table is newest-first, so "previous" is the next matching row. */
function previousPricedEvent(events: PriceHistoryEvent[], index: number): PriceHistoryEvent | null {
  const current = events[index];
  if (current.normalizedPrice === null) return null;
  for (let i = index + 1; i < events.length; i += 1) {
    const candidate = events[i];
    if (candidate.normalizedPrice !== null && candidate.currency === current.currency) return candidate;
  }
  return null;
}

function PriceHistoryRow({
  event,
  previous,
  expanded,
  onToggleExpand,
}: {
  event: PriceHistoryEvent;
  previous: PriceHistoryEvent | null;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const change = computePriceChange(event.normalizedPrice, previous?.normalizedPrice ?? null);
  const received = new Date(event.receivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const originalPrice =
    event.hasCorrection && event.lineTotal !== null && event.lineTotal > 0 && event.postedBaseQuantity > 0
      ? event.lineTotal / event.postedBaseQuantity
      : null;

  return (
    <>
      <tr className={tableRowClass}>
        <td className={`${tableCellClass} whitespace-nowrap`}>{received}</td>
        <td className={tableCellClass}>
          {event.vendorName ? event.vendorName : <span className="text-amber-400">Unknown vendor</span>}
          {event.isAmended ? <span className="ml-1.5 rounded border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400">Amended</span> : null}
          {event.hasCorrection ? (
            <button
              type="button"
              onClick={onToggleExpand}
              className="ml-1.5 rounded border border-amber-700/60 px-1 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950/30"
            >
              Corrected {expanded ? "▾" : "▸"}
            </button>
          ) : null}
        </td>
        <td className={tableCellMutedClass}>{event.vendorSku ?? "—"}</td>
        <td className={tableCellClass}>
          <Link href={`/manager/purchases/${event.currentRevisionId}`} className="font-medium text-amber-400 hover:underline">
            {event.documentNumber ? `#${event.documentNumber}` : "View"}
          </Link>
        </td>
        <td className={tableCellRightClass}>
          {event.packageQuantity !== null ? `${formatQuantityMagnitude(event.packageQuantity)} ${event.packageUnit ?? event.snapshotPurchaseUnitCode ?? ""}`.trim() : "—"}
        </td>
        <td className={tableCellMutedClass}>{conversionLabel(event)}</td>
        <td className={tableCellRightClass}>
          {formatQuantityMagnitude(event.authoritativeQuantity)} {event.baseUnitCode}
        </td>
        <td className={tableCellRightClass}>{event.lineTotal !== null ? formatMoney(event.lineTotal, event.currency) : "—"}</td>
        <td className={tableCellRightClass}>
          {event.normalizedPrice !== null ? (
            `${formatMoney(event.normalizedPrice, event.currency)} / ${event.baseUnitCode}`
          ) : (
            <span className="text-xs text-amber-400" title={priceUnavailableCopy(event.priceUnavailableReason)}>
              Unavailable
            </span>
          )}
        </td>
        <td className={tableCellRightClass}>
          {change ? (
            <span className={change.dollarChange > 0 ? "text-amber-400" : change.dollarChange < 0 ? "text-emerald-400" : "text-zinc-500"}>
              {change.dollarChange >= 0 ? "+" : "−"}
              {formatMoney(Math.abs(change.dollarChange), event.currency)}
              {change.percentChange !== null ? ` · ${change.percentChange >= 0 ? "+" : "−"}${Math.abs(change.percentChange).toFixed(1)}%` : ""}
            </span>
          ) : (
            <span className="text-zinc-600">—</span>
          )}
        </td>
      </tr>
      {event.normalizedPrice === null ? (
        <tr>
          <td colSpan={10} className="border-b border-zinc-800/70 px-3 pb-2.5 text-xs text-amber-400/80">
            {priceUnavailableCopy(event.priceUnavailableReason)}
          </td>
        </tr>
      ) : null}
      {expanded && event.hasCorrection ? (
        <tr>
          <td colSpan={10} className="border-b border-zinc-800/70 bg-zinc-950/40 px-3 py-2.5 text-xs text-zinc-400">
            <p>
              Original: {formatQuantityMagnitude(event.postedBaseQuantity)} {event.baseUnitCode}
              {originalPrice !== null ? ` → ${formatMoney(originalPrice, event.currency)} / ${event.baseUnitCode}` : ""}
            </p>
            <p>
              Corrected: {formatQuantityMagnitude(event.authoritativeQuantity)} {event.baseUnitCode}
              {event.normalizedPrice !== null ? ` → ${formatMoney(event.normalizedPrice, event.currency)} / ${event.baseUnitCode}` : ""}
            </p>
            {event.correctionReason ? <p className="mt-0.5">Reason: {event.correctionReason}</p> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
