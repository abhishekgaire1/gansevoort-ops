"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { listInventoryBalancesForOrganization, adjustInventoryFullReference } from "@/app/actions/inventory";
import type { InventoryBalanceRow } from "@/app/lib/inventory/listInventoryBalances";
import { computeStockGauge, stockLevelFillClass, stockLevelTextClass, STOCK_LEVEL_LABEL, type StockLevel } from "@/app/lib/inventory/stockLevel";

/**
 * Item + Location stock cards with tank-style fullness gauges. The fill
 * rises from the bottom like a tank draining/refilling; color follows the
 * derived stock level but is never the only signal -- fill height, the
 * numeric percentage, current quantity, and the full reference are always
 * shown alongside it.
 */

const STOCK_STATE_OPTIONS: ("ALL" | StockLevel)[] = ["ALL", "FULL", "HEALTHY", "MEDIUM", "LOW", "EMPTY"];

export function InventoryBalancesView() {
  const [rows, setRows] = useState<InventoryBalanceRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("ALL");
  const [stateFilter, setStateFilter] = useState<"ALL" | StockLevel>("ALL");

  const [adjustTarget, setAdjustTarget] = useState<InventoryBalanceRow | null>(null);
  const [adjustValue, setAdjustValue] = useState("");
  const [adjustPending, setAdjustPending] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listInventoryBalancesForOrganization();
    if (result.ok) setRows(result.rows);
  }, []);

  useEffect(() => {
    // Deliberate fetch-on-mount, same pattern as the app's other
    // section-level panels.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const locations = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows ?? []) byId.set(row.locationId, row.locationName);
    return Array.from(byId.entries());
  }, [rows]);

  const filtered = useMemo(() => {
    return (rows ?? []).filter((row) => {
      if (search.trim() !== "" && !row.itemName.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (locationFilter !== "ALL" && row.locationId !== locationFilter) return false;
      if (stateFilter !== "ALL") {
        const gauge = computeStockGauge(row.balance, row.fullReferenceQuantity);
        if (gauge.level !== stateFilter) return false;
      }
      return true;
    });
  }, [rows, search, locationFilter, stateFilter]);

  async function handleAdjustSave() {
    if (!adjustTarget || adjustPending) return;
    const value = Number(adjustValue);
    if (!Number.isFinite(value) || value <= 0) {
      setAdjustError("Enter a positive quantity.");
      return;
    }
    setAdjustPending(true);
    setAdjustError(null);
    const result = await adjustInventoryFullReference(adjustTarget.inventoryItemId, adjustTarget.locationId, value);
    setAdjustPending(false);
    if (!result.ok) {
      setAdjustError(result.message);
      return;
    }
    setAdjustTarget(null);
    setAdjustValue("");
    await load();
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Item name"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Location
          <select
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="ALL">All</option>
            {locations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Stock State
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as "ALL" | StockLevel)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          >
            {STOCK_STATE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "ALL" ? "All" : STOCK_LEVEL_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
          {rows.length === 0 ? "No stock received yet. Post a verified delivery to inventory to see balances here." : "No items match the current filters."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((row) => (
            <StockCard key={`${row.inventoryItemId}-${row.locationId}`} row={row} onAdjust={() => {
              setAdjustTarget(row);
              setAdjustValue(row.fullReferenceQuantity !== null ? String(row.fullReferenceQuantity) : "");
              setAdjustError(null);
            }} />
          ))}
        </div>
      )}

      {adjustTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Adjust Full Level</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-zinc-500">Item</p>
                <p className="text-zinc-100">{adjustTarget.itemName}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Location</p>
                <p className="text-zinc-100">{adjustTarget.locationName}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Current Inventory</p>
                <p className="text-zinc-100">
                  {formatQuantity(adjustTarget.balance)} {adjustTarget.baseUnitCode}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Current Full Reference</p>
                <p className="text-zinc-100">
                  {adjustTarget.fullReferenceQuantity !== null ? `${formatQuantity(adjustTarget.fullReferenceQuantity)} ${adjustTarget.baseUnitCode}` : "—"}
                </p>
              </div>
            </div>
            <label className="mt-4 flex flex-col gap-1 text-xs text-zinc-400">
              New Full Reference ({adjustTarget.baseUnitCode})
              <input
                type="number"
                value={adjustValue}
                onChange={(e) => setAdjustValue(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              />
            </label>
            <p className="mt-2 text-xs text-zinc-500">
              This changes the fullness visualization only. It does not change actual inventory.
            </p>
            {adjustError ? <p className="mt-2 text-xs text-red-400">{adjustError}</p> : null}
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={handleAdjustSave}
                disabled={adjustPending}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {adjustPending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setAdjustTarget(null)} className="text-sm text-zinc-400 underline">
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * Clickable card -> item detail (Inventory Item Detail + Activity
 * History milestone, Part 7) -- a "stretched link" covering the whole
 * card, with Adjust Full Level as an independently-clickable sibling
 * layered above it (never a <button> nested inside the <Link>, which
 * would be invalid, inaccessible HTML). The Link's own visible content is
 * empty (just an accessible name); the actual card content sits in a
 * pointer-events-none layer on top so clicks fall through to the Link
 * everywhere except the button, which re-enables its own pointer events.
 */
function StockCard({ row, onAdjust }: { row: InventoryBalanceRow; onAdjust: () => void }) {
  const gauge = computeStockGauge(row.balance, row.fullReferenceQuantity);
  const detailHref = `/manager/inventory/items/${row.inventoryItemId}?location=${row.locationId}`;

  return (
    <div className="group relative flex gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-600">
      <Link
        href={detailHref}
        className="absolute inset-0 z-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        aria-label={`View details for ${row.itemName} at ${row.locationName}`}
      />
      {/* Tank gauge -- fills from the BOTTOM upward. */}
      <div className="pointer-events-none relative z-10 h-28 w-16 shrink-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
        <div
          className={`absolute inset-x-0 bottom-0 transition-all ${stockLevelFillClass(gauge.level)}`}
          style={{ height: `${gauge.fillPercent}%` }}
        />
      </div>
      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-zinc-100 group-hover:text-amber-300">{row.itemName}</p>
        <p className="truncate text-xs text-zinc-500">{row.locationName}</p>
        {row.fullReferenceQuantity === null ? (
          <p className="mt-2 text-sm text-zinc-400">
            {formatQuantity(row.balance)} {row.baseUnitCode}
            <span className="mt-0.5 block text-xs text-zinc-500">{gauge.label}</span>
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-zinc-200">
              {formatQuantity(row.balance)} / {formatQuantity(row.fullReferenceQuantity)} {row.baseUnitCode}
            </p>
            <p className={`text-lg font-semibold ${stockLevelTextClass(gauge.level)}`}>
              {gauge.percent}%
              <span className="ml-2 text-xs font-normal">{gauge.label}</span>
            </p>
            {row.referenceSource === "MANAGER_OVERRIDE" ? <p className="text-[10px] uppercase tracking-wide text-zinc-600">Reference set by manager</p> : null}
          </>
        )}
        {row.includesLegacyEstimate ? (
          <p className="mt-1 text-[10px] text-zinc-600" title="A historical share of this balance was estimated once, at the 2A.5 cutover, from withdrawals recorded before exact source locations existed -- frozen permanently, never recalculated.">
            Includes estimated allocation from legacy withdrawals
          </p>
        ) : null}
        <button
          type="button"
          onClick={onAdjust}
          className="pointer-events-auto relative z-20 mt-2 text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          Adjust Full Level
        </button>
      </div>
    </div>
  );
}
