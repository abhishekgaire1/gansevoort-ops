"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listWasteStorageLocationsForOrganization,
  listStockedItemsAtLocationAction,
  recordInventoryWasteAction,
} from "@/app/actions/inventoryWaste";
import { WASTE_REASON_CODES, WASTE_REASON_LABELS, type WasteReasonCode } from "@/app/lib/inventory/wasteReasons";
import type { StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
import type { StockedItemAtLocation } from "@/app/lib/inventory/waste";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

type Step = "pick_location" | "pick_item" | "enter_details" | "review" | "done";

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * Record Inventory Waste (Part 5): Select Storage Location -> Select Item
 * -> Enter Waste Quantity + Reason -> Review -> Record Waste. Deliberately
 * fast -- quantity/reason/note are one screen, not three, matching the
 * "Keep it fast" instruction while still covering every field the spec's
 * screens show.
 */
export function RecordWasteView() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick_location");

  const [locations, setLocations] = useState<StorageEligibleLocation[] | null>(null);
  const [location, setLocation] = useState<StorageEligibleLocation | null>(null);

  const [items, setItems] = useState<StockedItemAtLocation[] | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  const [item, setItem] = useState<StockedItemAtLocation | null>(null);

  const [quantity, setQuantity] = useState("");
  const [reasonCode, setReasonCode] = useState<WasteReasonCode | null>(null);
  const [note, setNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [recordedQuantity, setRecordedQuantity] = useState<string | null>(null);

  useEffect(() => {
    listWasteStorageLocationsForOrganization().then((result) => {
      if (result.ok) setLocations(result.locations);
    });
  }, []);

  function selectLocation(loc: StorageEligibleLocation) {
    setLocation(loc);
    setItems(null);
    setStep("pick_item");
    listStockedItemsAtLocationAction(loc.id).then((result) => {
      if (result.ok) setItems(result.items);
    });
  }

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const query = itemQuery.trim().toLowerCase();
    if (query === "") return items;
    return items.filter((candidate) => candidate.itemName.toLowerCase().includes(query));
  }, [items, itemQuery]);

  function selectItem(candidate: StockedItemAtLocation) {
    setItem(candidate);
    setQuantity("");
    setReasonCode(null);
    setNote("");
    setStep("enter_details");
  }

  const quantityNum = Number(quantity);
  const isQuantityValid = quantity.trim() !== "" && Number.isFinite(quantityNum) && quantityNum > 0 && (item ? quantityNum <= item.balance : false);
  const isNoteOk = reasonCode !== "OTHER" || note.trim() !== "";
  const canContinueFromDetails = isQuantityValid && reasonCode !== null && isNoteOk;
  const previewAfter = item && Number.isFinite(quantityNum) ? item.balance - quantityNum : (item?.balance ?? 0);

  async function submit() {
    if (!location || !item || !reasonCode) return;
    setSubmitting(true);
    setError(null);
    const result = await recordInventoryWasteAction({
      locationId: location.id,
      inventoryItemId: item.inventoryItemId,
      quantity,
      reasonCode,
      note: note.trim() === "" ? null : note.trim(),
      clientRequestId,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRecordedQuantity(result.result.quantity);
    setStep("done");
  }

  return (
    <div className="mx-auto max-w-2xl">
      {step === "pick_location" ? (
        <div>
          <Link href="/manager/inventory/waste" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            ← Inventory Waste
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Select Storage Location</h1>
          <p className="mt-1 text-sm text-zinc-500">Waste must come from exactly one physical storage location.</p>
          <div className="mt-4 flex flex-col gap-2">
            {locations === null ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : locations.length === 0 ? (
              <EmptyState message="No storage locations found." />
            ) : (
              locations.map((loc) => (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => selectLocation(loc)}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-left text-sm font-medium text-zinc-100 hover:border-amber-400/40"
                >
                  {loc.name}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {step === "pick_item" && location ? (
        <div>
          <button
            type="button"
            onClick={() => setStep("pick_location")}
            className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
          >
            ← {location.name}
          </button>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Select Item</h1>
          <p className="mt-1 text-sm text-zinc-500">Only items currently in stock at {location.name} are shown.</p>
          <input
            type="text"
            value={itemQuery}
            onChange={(e) => setItemQuery(e.target.value)}
            placeholder="Search items…"
            aria-label="Search items"
            className="mt-4 w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <div className="mt-4 flex flex-col gap-2">
            {items === null ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : filteredItems.length === 0 ? (
              <EmptyState message={items.length === 0 ? "No items currently have stock at this location." : "No items match your search."} />
            ) : (
              filteredItems.map((candidate) => (
                <button
                  key={candidate.inventoryItemId}
                  type="button"
                  onClick={() => selectItem(candidate)}
                  className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-left hover:border-amber-400/40"
                >
                  <span className="text-sm font-medium text-zinc-100">{candidate.itemName}</span>
                  <span className="text-sm text-zinc-500">
                    {formatQuantity(candidate.balance)} {candidate.baseUnitCode}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {step === "enter_details" && location && item ? (
        <div>
          <button
            type="button"
            onClick={() => setStep("pick_item")}
            className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
          >
            ← {item.itemName}
          </button>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">{item.itemName}</h1>
          <p className="mt-1 text-sm text-zinc-500">{location.name}</p>

          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current Inventory</p>
            <p className="mt-1 text-lg font-semibold text-zinc-100">
              {formatQuantity(item.balance)} {item.baseUnitCode}
            </p>

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Waste Quantity</p>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-32 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-lg text-zinc-100"
              />
              <span className="text-sm text-zinc-400">{item.baseUnitCode}</span>
            </div>
            {quantity.trim() !== "" && !isQuantityValid ? (
              <p className="mt-1 text-xs text-red-400">
                {quantityNum > item.balance ? `Cannot exceed ${formatQuantity(item.balance)} ${item.baseUnitCode} available.` : "Enter a valid quantity."}
              </p>
            ) : null}

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Inventory After Waste</p>
            <p className="mt-1 text-lg font-semibold text-zinc-100">
              {formatQuantity(Number.isFinite(previewAfter) ? Math.max(previewAfter, 0) : item.balance)} {item.baseUnitCode}
            </p>
          </div>

          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Reason</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {WASTE_REASON_CODES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setReasonCode(code)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                    reasonCode === code ? "bg-amber-400 text-zinc-950" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {WASTE_REASON_LABELS[code]}
                </button>
              ))}
            </div>

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Note {reasonCode === "OTHER" ? "(required)" : "(optional)"}
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={reasonCode === "OTHER" ? "Describe the reason for this waste…" : "Optional details…"}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          <button
            type="button"
            disabled={!canContinueFromDetails}
            onClick={() => setStep("review")}
            className={`mt-4 w-full ${primaryButtonClass}`}
          >
            Continue to Review
          </button>
        </div>
      ) : null}

      {step === "review" && location && item && reasonCode ? (
        <div>
          <button
            type="button"
            onClick={() => setStep("enter_details")}
            className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
          >
            ← Edit
          </button>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">Review Waste</h1>

          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <Row label="Item" value={item.itemName} />
            <Row label="Storage Location" value={location.name} />
            <Row label="Waste Quantity" value={`${formatQuantity(quantityNum)} ${item.baseUnitCode}`} />
            <Row label="Inventory After Waste" value={`${formatQuantity(Math.max(item.balance - quantityNum, 0))} ${item.baseUnitCode}`} />
            <Row label="Reason" value={WASTE_REASON_LABELS[reasonCode]} />
            {note.trim() !== "" ? <Row label="Note" value={note.trim()} /> : null}
          </div>

          {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className={`mt-4 w-full ${primaryButtonClass}`}
          >
            {submitting ? "Recording…" : "Record Waste"}
          </button>
        </div>
      ) : null}

      {step === "done" && item && location && recordedQuantity ? (
        <div className="rounded-2xl border border-emerald-900 bg-zinc-900 p-6 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">Inventory Waste Recorded</p>
          <p className="mt-2 text-lg font-semibold text-zinc-100">
            {formatQuantity(Number(recordedQuantity))} {item.baseUnitCode} {item.itemName} removed from {location.name}.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => router.push("/manager/inventory/waste")}
              className={primaryButtonClass}
            >
              Back to Inventory Waste
            </button>
            <button
              type="button"
              onClick={() => router.refresh()}
              className={secondaryButtonClass}
            >
              Record Another
            </button>
          </div>
        </div>
      ) : null}
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
