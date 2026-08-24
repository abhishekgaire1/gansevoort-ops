"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getInventoryWasteDetailAction } from "@/app/actions/inventoryWaste";
import { WASTE_REASON_LABELS } from "@/app/lib/inventory/wasteReasons";
import type { InventoryWasteEventDetail } from "@/app/lib/inventory/waste";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { EmptyState } from "@/app/components/manager/EmptyState";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatQuantity(value: string): string {
  const num = Number(value);
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

/** Read-only Inventory Waste detail (Part 19) -- no Edit, no Delete. It
 * represents a posted, append-only ledger event; a mistake needs an
 * explicit future reversal workflow, not an edit here. */
export function WasteDetailView({ wasteEventId }: { wasteEventId: string }) {
  const [detail, setDetail] = useState<InventoryWasteEventDetail | null | undefined>(undefined);

  useEffect(() => {
    getInventoryWasteDetailAction(wasteEventId).then((result) => {
      if (result.ok) setDetail(result.detail);
    });
  }, [wasteEventId]);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/manager/inventory/waste" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
        ← Inventory Waste
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-zinc-100">Inventory Waste</h1>

      {detail === undefined ? (
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      ) : detail === null ? (
        <div className="mt-4">
          <EmptyState message="This waste record was not found." />
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <p className="text-lg font-semibold text-zinc-100">{detail.itemName}</p>
            <div className="mt-1">
              <StatusBadge label="Recorded" tone="neutral" />
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <Row label="Storage Location" value={detail.locationName} />
            <Row label="Quantity" value={`${formatQuantity(detail.quantity)} ${detail.unitCode}`} />
            <Row label="Reason" value={WASTE_REASON_LABELS[detail.reasonCode]} />
            <Row label="Recorded By" value={detail.recordedByName} />
            <Row label="Recorded" value={formatDateTime(detail.recordedAt)} />
          </div>

          {detail.note ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Note</p>
              <p className="mt-2 text-sm text-zinc-200">{detail.note}</p>
            </div>
          ) : null}

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Inventory Movement</p>
            <p className="mt-2 text-sm text-zinc-200">WASTE · {detail.inventoryMovementId}</p>
          </div>

          {detail.cycleCountId ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Identified During</p>
              <Link href={`/manager/inventory/cycle-count/${detail.cycleCountId}`} className="mt-2 block text-sm font-medium text-amber-400 hover:underline">
                Cycle Count →
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 py-2 last:border-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-100">{value}</span>
    </div>
  );
}
