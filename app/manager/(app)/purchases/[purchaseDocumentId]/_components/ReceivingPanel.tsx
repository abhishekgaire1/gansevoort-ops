"use client";

import { useCallback, useEffect, useState } from "react";
import {
  recordReceipt,
  listEffectiveReceiptsForPurchaseDocument,
  getReceivingLinesForPurchaseDocument,
  getEffectiveReceivingLinesForPurchaseDocument,
  correctEffectiveReceiving,
  listLocations,
  type EffectiveReceiptRow,
  type LocationSummary,
} from "@/app/actions/receiving";
import type { ReceivingLineEdit } from "@/app/lib/receiving/effectiveReceivingEdit";
import { computeReceivingPrefill, recomputeFixedConversionVerifiedQuantity } from "@/app/lib/receiving/computeReceivingPrefill";
import { mergeReceivingLineState, type ReceivingLineDraft } from "@/app/lib/receiving/mergeReceivingLineState";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

/**
 * Step 3 -- "the invoice is what we expected, the manager only changes
 * exceptions." Safe values are prefilled as an editable DRAFT UI state
 * (see computeReceivingPrefill.ts for exactly what's safe to assume and
 * why) -- nothing becomes an authoritative receipt until Confirm Receiving
 * is pressed. Per-line behavior is read from getReceivingLinesForPurchaseDocument
 * (derived from each item's OWN confirmed inventory_item_units config, see
 * 20260811100045) -- never re-guessed here. NON_INVENTORY lines are never
 * shown as a physical receiving requirement at all.
 *
 * "Expected" and the initial "Received" draft value are both derived from
 * the exact same computeReceivingPrefill call (via mergeReceivingLineState)
 * -- there is deliberately no second, independent fallback calculation
 * that could disagree with it. mergeReceivingLineState also owns every
 * subsequent load (poll, refetch after submit, another manager's
 * confirmation landing) -- it never blindly discards a field the manager
 * has already filled in, only merges fresh prefill into a field that is
 * still genuinely blank.
 */

type LineReceiptState = ReceivingLineDraft;

/** The only two units a bare invoice quantity could plausibly mean for a
 * packaged item -- its base unit, or its purchase/packaging unit. Never
 * the full global unit list: an unrelated unit (e.g. GALLON for a
 * CASE/PIECE item) is never a real candidate. */
function invoiceUnitCandidates(info: ReceivingLineInfo): string[] {
  return Array.from(new Set([info.baseUnitCode, info.purchaseUnitCode].filter((u): u is string => u !== null)));
}

/** True when this line's invoice unit is genuinely unresolved (or
 * conflicting) and needs the manager's inline confirmation -- never for
 * SAME_UNIT (assessed separately, always safely falls back to the base
 * unit on its own) and never once a unit has already been resolved
 * (receivedUnit non-blank), even if the manager clears the quantity. */
function needsInvoiceUnitResolution(l: LineReceiptState): boolean {
  return l.receivedUnit.trim() === "" && l.info.invoicePackageQuantity !== null && l.info.receivingBehavior !== null && l.info.receivingBehavior !== "SAME_UNIT";
}

function lineIsReady(l: LineReceiptState): boolean {
  if (l.receivedQuantity.trim() === "") return false;
  if (l.info.requiresVerifiedMeasurement && l.verifiedQuantity.trim() === "") return false;
  if (l.locationId.trim() === "") return false;
  return true;
}

export function ReceivingPanel({
  purchaseDocumentId,
  readOnly,
  collapseWhenReceived,
  onChange,
}: {
  purchaseDocumentId: string;
  readOnly?: boolean;
  /** Step 3's wizard mode: once a delivery has been recorded, the
   * editable entry form collapses into a recorded-delivery summary, and
   * "Record Additional Delivery" becomes an explicit, de-emphasized
   * secondary action for a genuinely separate later/partial delivery --
   * never the implied next step of an already-complete receipt. The
   * recorded EFFECTIVE receipt is what drives wizard completion; an
   * unopened additional-delivery form must never make a complete
   * delivery look incomplete. */
  collapseWhenReceived?: boolean;
  /** Fires after every load AND every successful receipt submission --
   * lets the wizard re-check the authoritative completion gate
   * (getPreparationStatus). Whether step 3 is actually "done" is never
   * decided by this panel's own local draft-form state, only by that
   * gate, since a filled-in-but-unsubmitted draft is not yet a real
   * receipt. */
  onChange?: () => void;
}) {
  const [receipts, setReceipts] = useState<EffectiveReceiptRow[] | null>(null);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [lineState, setLineState] = useState<LineReceiptState[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyReceived, setAlreadyReceived] = useState(false);
  const [showAdditionalForm, setShowAdditionalForm] = useState(false);

  // Edit Receiving (DRAFT only): a SEPARATE mode from recording an
  // additional delivery -- it corrects the existing effective receiving
  // facts via append-only receipt corrections, never a new delivery event.
  interface EditLineDraft {
    receiptLineId: string;
    matchedLineKey: string;
    itemLabel: string;
    info: ReceivingLineInfo | null;
    receivedQuantity: string;
    receivedUnit: string;
    verifiedQuantity: string;
    locationId: string;
    conditionStatus: LineReceiptState["conditionStatus"];
    original: { receivedQuantity: string; receivedUnit: string; verifiedQuantity: string; locationId: string; conditionStatus: string };
  }
  const [editState, setEditState] = useState<EditLineDraft[] | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSessionKey, setEditSessionKey] = useState(() => crypto.randomUUID());

  async function handleOpenEditReceiving() {
    setEditError(null);
    setEditSessionKey(crypto.randomUUID()); // a fresh edit session = a fresh idempotency scope
    const result = await getEffectiveReceivingLinesForPurchaseDocument(purchaseDocumentId);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const infoByLineKey = new Map(lineState.map((l) => [l.lineKey, l.info]));
    setEditState(
      result.lines.map((line) => {
        const info = infoByLineKey.get(line.matchedLineKey) ?? null;
        return {
          receiptLineId: line.receiptLineId,
          matchedLineKey: line.matchedLineKey,
          itemLabel: line.descriptionSnapshot ?? info?.description ?? "—",
          info,
          receivedQuantity: line.receivedQuantity !== null ? String(line.receivedQuantity) : "",
          receivedUnit: line.receivedUnit ?? "",
          verifiedQuantity: line.verifiedBaseQuantity !== null ? String(line.verifiedBaseQuantity) : "",
          locationId: line.locationId ?? "",
          conditionStatus: line.conditionStatus as LineReceiptState["conditionStatus"],
          original: {
            receivedQuantity: line.receivedQuantity !== null ? String(line.receivedQuantity) : "",
            receivedUnit: line.receivedUnit ?? "",
            verifiedQuantity: line.verifiedBaseQuantity !== null ? String(line.verifiedBaseQuantity) : "",
            locationId: line.locationId ?? "",
            conditionStatus: line.conditionStatus,
          },
        };
      })
    );
  }

  function updateEditLine(receiptLineId: string, patch: Partial<Pick<EditLineDraft, "receivedQuantity" | "receivedUnit" | "verifiedQuantity" | "locationId" | "conditionStatus">>) {
    setEditState((prev) =>
      (prev ?? []).map((line) => {
        if (line.receiptLineId !== receiptLineId) return line;
        const next = { ...line, ...patch };
        // Same FIXED_CONVERSION consistency rule as the entry form: a
        // corrected received quantity/unit immediately re-derives the
        // verified base quantity (record_receipt re-validates it
        // server-side regardless).
        if (line.info?.receivingBehavior === "FIXED_CONVERSION" && (patch.receivedQuantity !== undefined || patch.receivedUnit !== undefined)) {
          next.verifiedQuantity = recomputeFixedConversionVerifiedQuantity(line.info, next.receivedQuantity, next.receivedUnit);
        }
        return next;
      })
    );
  }

  async function handleSaveReceivingChanges() {
    if (!editState || editPending) return;
    const edits: ReceivingLineEdit[] = editState
      .filter(
        (line) =>
          line.receivedQuantity !== line.original.receivedQuantity ||
          line.receivedUnit !== line.original.receivedUnit ||
          line.verifiedQuantity !== line.original.verifiedQuantity ||
          line.locationId !== line.original.locationId ||
          line.conditionStatus !== line.original.conditionStatus
      )
      .map((line) => ({
        receiptLineId: line.receiptLineId,
        receivedQuantity: Number(line.receivedQuantity),
        receivedUnit: line.receivedUnit || null,
        verifiedBaseQuantity: line.verifiedQuantity.trim() !== "" ? Number(line.verifiedQuantity) : null,
        locationId: line.locationId || null,
        conditionStatus: line.conditionStatus,
      }));

    if (edits.length === 0) {
      setEditState(null); // nothing changed -- just close
      return;
    }
    const invalid = edits.find((edit) => !Number.isFinite(edit.receivedQuantity) || edit.receivedQuantity < 0);
    if (invalid) {
      setEditError("Each corrected line needs a valid received quantity.");
      return;
    }

    setEditPending(true);
    setEditError(null);
    const result = await correctEffectiveReceiving({ purchaseDocumentId, editSessionKey, edits });
    setEditPending(false);
    if (!result.ok) {
      setEditError(result.message);
      return; // retry-safe: same session key replays the same corrections
    }
    setEditState(null);
    await load();
  }
  // A stable key for the CURRENT logical submission attempt -- a
  // double-click or slow-network retry before this rotates sends the
  // SAME key, so record_receipt collapses it into one receipt instead of
  // two (20260811100061). Rotated only after a successful submit, so the
  // NEXT distinct submission (including "Record Additional Receipt")
  // gets its own fresh key -- never derived from document/line identity,
  // since legitimate additional deliveries must remain possible.
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());

  const load = useCallback(async () => {
    const [receiptsResult, linesResult, locationsResult] = await Promise.all([
      listEffectiveReceiptsForPurchaseDocument(purchaseDocumentId),
      getReceivingLinesForPurchaseDocument(purchaseDocumentId),
      listLocations(),
    ]);
    if (receiptsResult.ok) {
      setReceipts(receiptsResult.receipts);
      setAlreadyReceived(receiptsResult.receipts.some((r) => r.receiptKind === "DELIVERY"));
    }
    if (locationsResult.ok) setLocations(locationsResult.locations);
    if (linesResult.ok) {
      const soleLocationId = locationsResult.ok && locationsResult.locations.length === 1 ? locationsResult.locations[0].id : "";
      setDefaultLocationId((current) => current || soleLocationId);
      const loadedLocations = locationsResult.ok ? locationsResult.locations : [];
      // Functional update -- reads the CURRENT draft state at merge time
      // without needing lineState in this callback's own dependencies,
      // so load()'s identity (and therefore the mount effect below) stays
      // stable across the manager's own edits.
      setLineState((prev) => mergeReceivingLineState(linesResult.lines, loadedLocations, prev));
    }
    onChange?.();
  }, [purchaseDocumentId, onChange]);

  useEffect(() => {
    // Deliberate fetch-on-mount, same pattern as NotificationBell's own
    // fetch-on-mount effect -- there's no props/state this could be
    // derived from during render.
    load();
  }, [load]);

  function updateLine(lineKey: string, patch: Partial<LineReceiptState>) {
    setLineState((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  }

  /** Received Qty/Unit's own onChange handler for FIXED_CONVERSION lines --
   * keeps the derived base-unit quantity (shown just below the field, and
   * ultimately what's submitted as actualVerifiedBaseQuantity) in sync
   * with whatever the manager just typed, e.g. correcting a shortage from
   * "2 CASE" (48 PIECE) down to "1 CASE" immediately re-derives 24 PIECE
   * rather than silently leaving the stale 48. A no-op for every other
   * receiving behavior -- updateLine alone is still correct for those. */
  function updateReceivedQuantityOrUnit(lineKey: string, patch: { receivedQuantity?: string; receivedUnit?: string }) {
    setLineState((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        const next = { ...l, ...patch };
        if (l.info.receivingBehavior !== "FIXED_CONVERSION") return next;
        return { ...next, verifiedQuantity: recomputeFixedConversionVerifiedQuantity(l.info, next.receivedQuantity, next.receivedUnit) };
      })
    );
  }

  /** The manager picking an Invoice Unit is treated exactly like the
   * invoice having stated that unit itself -- reusing computeReceivingPrefill
   * (with the chosen unit substituted in as invoicePackageUnit) rather than
   * re-deriving the FIXED_CONVERSION-factor/verified-quantity logic here a
   * second time. Clearing the choice reverts to genuinely unresolved. */
  function handleInvoiceUnitChoice(lineKey: string, unit: string) {
    setLineState((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        if (unit === "") return { ...l, invoiceUnitChoice: "", receivedQuantity: "", receivedUnit: "", verifiedQuantity: "" };
        const resolved = computeReceivingPrefill({ ...l.info, invoicePackageUnit: unit, confirmedInvoiceUnitCode: null });
        return { ...l, invoiceUnitChoice: unit, receivedQuantity: resolved.receivedQuantity, receivedUnit: resolved.receivedUnit, verifiedQuantity: resolved.verifiedQuantity };
      })
    );
  }

  function handleEverythingReceivedAsInvoiced() {
    // Safe quantities are already prefilled on load -- this button is not
    // required to populate them. It only re-applies/accepts the safe
    // expected values on lines still untouched (receivedQuantity blank),
    // the same rule mergeReceivingLineState already uses for every other
    // refetch -- a line the manager has already edited (e.g. entered 58
    // instead of the invoiced 60) is left exactly as they left it, never
    // silently reverted back to "as invoiced". A variable-measurement
    // line's Verified field is still never touched either way.
    setLineState((prev) =>
      prev.map((l) => {
        if (l.receivedQuantity.trim() !== "") return l;
        const prefill = computeReceivingPrefill(l.info);
        return prefill.receivedQuantity
          ? { ...l, receivedQuantity: prefill.receivedQuantity, receivedUnit: prefill.receivedUnit, verifiedQuantity: prefill.verifiedQuantity, conditionStatus: "RECEIVED_AS_INVOICED" as const }
          : l;
      })
    );
  }

  function handleApplyDefaultLocationToAll() {
    // Fills gaps only -- an item's own remembered default (or any location
    // the manager already picked for this delivery) is never overwritten
    // just because a delivery-level default was selected and applied.
    if (!defaultLocationId) return;
    setLineState((prev) => prev.map((l) => (l.locationId ? l : { ...l, locationId: defaultLocationId })));
  }

  async function handleSubmit() {
    for (const l of lineState) {
      if (l.receivedQuantity.trim() !== "" && l.info.requiresVerifiedMeasurement && l.verifiedQuantity.trim() === "") {
        setError(`"${l.info.description ?? l.lineKey}" requires a verified ${l.info.baseUnitCode ?? "measurement"} -- it varies by delivery and can't be assumed from the invoice.`);
        return;
      }
    }

    setPending(true);
    setError(null);
    const includedLines = lineState.filter((l) => l.receivedQuantity.trim() !== "");
    const result = await recordReceipt({
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      defaultLocationId: defaultLocationId || null,
      notes: notes.trim() || null,
      idempotencyKey: submissionKey,
      lines: includedLines.map((l) => ({
        lineNumberSnapshot: null,
        matchedLineKey: l.lineKey,
        vendorSkuSnapshot: l.info.vendorSku,
        descriptionSnapshot: l.info.description,
        invoicePackageQuantity: l.info.invoicePackageQuantity,
        invoicePackageUnit: l.info.invoicePackageUnit,
        invoiceMeasuredQuantity: null,
        invoiceMeasuredUnit: null,
        actualReceivedPackageQuantity: Number(l.receivedQuantity),
        actualReceivedPackageUnit: l.receivedUnit || null,
        actualVerifiedBaseQuantity: l.verifiedQuantity.trim() !== "" ? Number(l.verifiedQuantity) : null,
        actualVerifiedBaseUnitId: l.verifiedQuantity.trim() !== "" ? l.info.baseUnitId : null,
        locationId: l.locationId || null,
        conditionStatus: l.conditionStatus,
      })),
      // Only for lines actually being confirmed, with a real item and a
      // chosen location -- this is what "the newly confirmed location
      // becomes the item's current default for future receiving" means:
      // a receipt that's about to become authoritative, not a draft edit.
      rememberLocations: includedLines
        .filter((l) => l.info.inventoryItemId !== null && l.locationId.trim() !== "")
        .map((l) => ({ inventoryItemId: l.info.inventoryItemId as string, locationId: l.locationId })),
      // Only lines where the manager actually made an inline invoice-unit
      // choice -- an already-safely-prefilled line (nothing ambiguous to
      // resolve) never calls this, and submitting IS the confirmation act.
      confirmedInvoiceUnits: includedLines
        .filter((l) => l.invoiceUnitChoice !== "")
        .map((l) => ({ lineKey: l.lineKey, unitCode: l.invoiceUnitChoice, rememberForVendor: l.rememberInvoiceUnit })),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotes("");
    setSubmissionKey(crypto.randomUUID());
    setShowAdditionalForm(false); // a successful submit collapses back to the recorded summary
    await load();
  }

  const exceptionCount = lineState.filter((l) => !lineIsReady(l)).length;

  // Collapsed recorded-summary mode: an effective delivery exists and the
  // manager hasn't explicitly started an additional one. The editable
  // entry form is hidden entirely -- it exists again only through the
  // explicit secondary action below.
  const editing = editState !== null;
  const collapsed = Boolean(collapseWhenReceived) && !readOnly && alreadyReceived && !showAdditionalForm && !editing;
  const formVisible = !readOnly && lineState.length > 0 && !collapsed && !editing;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Receive Delivery</h2>

        {receipts === null ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : receipts.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 text-sm text-zinc-300">
            {receipts.map((r) => (
              <li key={r.id} className="flex items-center justify-between">
                <span>
                  {r.receiptKind === "CORRECTION" ? "Correction" : "Delivery"} recorded {new Date(r.occurredAt).toLocaleString()}
                </span>
                {r.notes ? <span className="text-xs text-zinc-500">{r.notes}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

        {collapsed ? (
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <p className="text-sm font-semibold text-emerald-400">✓ Delivery recorded</p>
            <p className="mt-1 text-xs text-zinc-500">
              The recorded delivery above is the authoritative receiving record for this document. Only record another
              receipt for a genuinely separate later or partial delivery.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* EDIT corrects the existing delivery's facts (append-only
                  correction); ADDITIONAL records a genuinely separate
                  physical delivery. Deliberately distinct actions. */}
              <button
                type="button"
                onClick={handleOpenEditReceiving}
                className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:text-zinc-100"
              >
                Edit Receiving
              </button>
              <button
                type="button"
                onClick={() => setShowAdditionalForm(true)}
                className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:text-zinc-100"
              >
                Record Additional Delivery
              </button>
            </div>
          </div>
        ) : null}

        {editing ? (
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <p className="text-sm font-semibold text-zinc-200">Edit Receiving</p>
            <p className="mt-1 text-xs text-zinc-500">
              Corrections are recorded as a new receiving correction -- the original receipt is preserved in history, and
              the corrected values become the effective receiving record.
            </p>
          </div>
        ) : null}

        {formVisible ? (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-4">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Default location for this delivery
                <select
                  value={defaultLocationId}
                  onChange={(e) => setDefaultLocationId(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                >
                  <option value="">Select…</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={handleApplyDefaultLocationToAll} disabled={!defaultLocationId} className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-200 disabled:opacity-40">
                Apply to All Eligible Lines
              </button>
              <button type="button" onClick={handleEverythingReceivedAsInvoiced} className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950">
                Everything Received As Invoiced
              </button>
            </div>

            <p className="mt-3 text-xs text-zinc-500">
              {exceptionCount === 0 ? "✓ All lines ready to confirm." : `${exceptionCount} line${exceptionCount === 1 ? "" : "s"} still ${exceptionCount === 1 ? "needs" : "need"} attention.`}
            </p>
          </>
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800">
            {(editState ?? []).map((line) => (
              <div key={line.receiptLineId} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{line.itemLabel}</span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    Was: {line.original.receivedQuantity || "—"} {line.original.receivedUnit}
                    {line.original.verifiedQuantity ? ` · ${line.original.verifiedQuantity} ${line.info?.baseUnitCode ?? ""}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Received
                    <div className="flex gap-1">
                      <input
                        type="number"
                        value={line.receivedQuantity}
                        onChange={(e) => updateEditLine(line.receiptLineId, { receivedQuantity: e.target.value })}
                        placeholder="Qty"
                        className="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                      />
                      <input
                        type="text"
                        value={line.receivedUnit}
                        onChange={(e) => updateEditLine(line.receiptLineId, { receivedUnit: e.target.value })}
                        placeholder="Unit"
                        className="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                      />
                    </div>
                    {line.info?.receivingBehavior === "FIXED_CONVERSION" && line.verifiedQuantity.trim() !== "" ? (
                      <span className="text-xs text-zinc-500">
                        → {line.verifiedQuantity} {line.info.baseUnitCode}
                      </span>
                    ) : null}
                  </label>

                  {line.info?.requiresVerifiedMeasurement ? (
                    <label className="flex flex-col gap-0.5 text-xs text-amber-400">
                      Verified {line.info.baseUnitCode} <span className="text-amber-500">REQUIRED</span>
                      <input
                        type="number"
                        value={line.verifiedQuantity}
                        onChange={(e) => updateEditLine(line.receiptLineId, { verifiedQuantity: e.target.value })}
                        placeholder={line.info.baseUnitCode ?? ""}
                        className="w-28 rounded-lg border border-amber-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                      />
                    </label>
                  ) : null}

                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Location
                    <select
                      value={line.locationId}
                      onChange={(e) => updateEditLine(line.receiptLineId, { locationId: e.target.value })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                    >
                      <option value="">Select…</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Condition
                    <select
                      value={line.conditionStatus}
                      onChange={(e) => updateEditLine(line.receiptLineId, { conditionStatus: e.target.value as LineReceiptState["conditionStatus"] })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                    >
                      <option value="RECEIVED_AS_INVOICED">As invoiced</option>
                      <option value="SHORT">Short</option>
                      <option value="DAMAGED">Damaged</option>
                      <option value="WRONG_ITEM">Wrong item</option>
                      <option value="NOT_RECEIVED">Not received</option>
                      <option value="EXCESS">Excess</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>
          {editError ? <p className="text-sm text-red-400">{editError}</p> : null}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveReceivingChanges}
              disabled={editPending}
              className="self-start rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
            >
              {editPending ? "Saving receiving changes…" : "Save Receiving Changes"}
            </button>
            <button type="button" onClick={() => setEditState(null)} className="text-xs text-zinc-400 underline underline-offset-2">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {lineState.length > 0 && !collapsed && !editing ? (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800">
          {lineState.map((l) => {
            const ready = lineIsReady(l);
            return (
              <div key={l.lineKey} className={`flex flex-col gap-2 p-4 ${ready ? "" : "bg-amber-950/10"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{l.info.description ?? "—"}</span>
                  <span className={`shrink-0 text-xs font-semibold ${ready ? "text-emerald-400" : "text-amber-400"}`}>{ready ? "✓ Ready" : "⚠ Needs input"}</span>
                </div>
                {needsInvoiceUnitResolution(l) ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-amber-800 bg-amber-950/20 p-3">
                    {l.invoiceUnitConflict ? (
                      <p className="text-xs text-amber-400">
                        Invoice says: <span className="font-semibold">{l.invoiceUnitConflict.invoiceUnit}</span> · Previously remembered:{" "}
                        <span className="font-semibold">{l.invoiceUnitConflict.rememberedUnit}</span> · Needs review.
                      </p>
                    ) : (
                      <p className="text-xs text-amber-400">Invoice unit not stated -- resolve it once and it will be remembered.</p>
                    )}
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                        Invoice Quantity
                        <span className="text-sm text-zinc-100">{l.info.invoicePackageQuantity}</span>
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                        Invoice Unit
                        <select
                          value={l.invoiceUnitChoice}
                          disabled={readOnly}
                          onChange={(e) => handleInvoiceUnitChoice(l.lineKey, e.target.value)}
                          className="rounded-lg border border-amber-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                        >
                          <option value="">Select…</option>
                          {invoiceUnitCandidates(l.info).map((unit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </select>
                      </label>
                      {l.info.receivingBehavior === "FIXED_CONVERSION" && l.info.purchaseUnitCode && l.info.baseUnitCode && l.info.fixedConversionFactor !== null ? (
                        <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                          Packaging
                          <span className="text-sm text-zinc-100">
                            1 {l.info.purchaseUnitCode} = {l.info.fixedConversionFactor} {l.info.baseUnitCode}
                          </span>
                        </label>
                      ) : null}
                    </div>
                    {l.info.vendorSku ? (
                      <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={l.rememberInvoiceUnit}
                          disabled={readOnly}
                          onChange={(e) => updateLine(l.lineKey, { rememberInvoiceUnit: e.target.checked })}
                        />
                        Remember {l.invoiceUnitChoice || "this unit"} for future invoices of this item
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">
                    {/* Never guesses a unit the invoice didn't state -- shows
                        the invoice's own stated unit, or whatever
                        computeReceivingPrefill itself resolved (e.g. a
                        SAME_UNIT base-unit fallback), and otherwise says so
                        plainly rather than implying a unit that was assumed. */}
                    Expected: {l.info.invoicePackageQuantity ?? "—"} {l.info.invoicePackageUnit ?? (computeReceivingPrefill(l.info).receivedUnit || "[unit needs confirmation]")}
                  </p>
                )}

                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Received
                    <div className="flex gap-1">
                      <input
                        type="number"
                        value={l.receivedQuantity}
                        disabled={readOnly}
                        onChange={(e) => updateReceivedQuantityOrUnit(l.lineKey, { receivedQuantity: e.target.value })}
                        placeholder="Qty"
                        className="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                      />
                      <input
                        type="text"
                        value={l.receivedUnit}
                        disabled={readOnly}
                        onChange={(e) => updateReceivedQuantityOrUnit(l.lineKey, { receivedUnit: e.target.value })}
                        placeholder="Unit"
                        className="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                      />
                    </div>
                    {l.info.receivingBehavior === "FIXED_CONVERSION" && l.verifiedQuantity.trim() !== "" ? (
                      <span className="text-xs text-zinc-500">
                        → {l.verifiedQuantity} {l.info.baseUnitCode}
                      </span>
                    ) : null}
                  </label>

                  {l.info.requiresVerifiedMeasurement ? (
                    <label className="flex flex-col gap-0.5 text-xs text-amber-400">
                      Verified {l.info.baseUnitCode} <span className="text-amber-500">REQUIRED</span>
                      <input
                        type="number"
                        value={l.verifiedQuantity}
                        disabled={readOnly}
                        onChange={(e) => updateLine(l.lineKey, { verifiedQuantity: e.target.value })}
                        placeholder={l.info.baseUnitCode ?? ""}
                        className="w-28 rounded-lg border border-amber-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                      />
                    </label>
                  ) : null}

                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Location
                    <select
                      value={l.locationId}
                      disabled={readOnly}
                      onChange={(e) => updateLine(l.lineKey, { locationId: e.target.value })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                    >
                      <option value="">Select…</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-0.5 text-xs text-zinc-500">
                    Condition
                    <select
                      value={l.conditionStatus}
                      disabled={readOnly}
                      onChange={(e) => updateLine(l.lineKey, { conditionStatus: e.target.value as LineReceiptState["conditionStatus"] })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 disabled:opacity-60"
                    >
                      <option value="RECEIVED_AS_INVOICED">As invoiced</option>
                      <option value="SHORT">Short</option>
                      <option value="DAMAGED">Damaged</option>
                      <option value="WRONG_ITEM">Wrong item</option>
                      <option value="NOT_RECEIVED">Not received</option>
                      <option value="EXCESS">Excess</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      ) : lineState.length === 0 && receipts !== null ? (
        <p className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">No inventory lines to receive on this document.</p>
      ) : null}

      {formVisible ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
          </label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleSubmit} disabled={pending} className="self-start rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40">
              {pending ? "Recording receipt…" : alreadyReceived ? "Record Additional Delivery Receipt" : "Confirm Receiving"}
            </button>
            {alreadyReceived && collapseWhenReceived ? (
              <button type="button" onClick={() => setShowAdditionalForm(false)} className="text-xs text-zinc-400 underline underline-offset-2">
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
