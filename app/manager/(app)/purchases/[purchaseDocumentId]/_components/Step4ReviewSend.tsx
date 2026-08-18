"use client";

import { useEffect, useState } from "react";
import { getPurchaseDocumentReviewSummary } from "@/app/actions/purchaseDocuments";
import { listActiveEmployees, correctDocumentDeliveryVerifier, type EmployeeSummary } from "@/app/actions/receiving";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { PurchaseDocumentHeaderDraft } from "@/app/lib/purchaseDocuments/types";

/**
 * Step 4 -- Manager 1's last look before sending to Manager 2. Two
 * distinct jobs, kept clearly separate:
 *   1. Readiness (top) -- driven ENTIRELY by preparationStatus, the same
 *      RPC-enforced rule submit_purchase_document_for_verification itself
 *      uses (see getPreparationStatus.ts) -- never recomputed here.
 *   2. The detailed read-only review below it -- purely a formatted
 *      display of getPurchaseDocumentReviewSummary, itself just an
 *      aggregation of what earlier steps already produced. Nothing here
 *      is editable; a manager who spots a problem navigates back via the
 *      stepper (onNavigateToStep) to actually fix it.
 */

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

const RECEIVING_BEHAVIOR_LABEL: Record<string, string> = {
  SAME_UNIT: "Same unit",
  FIXED_CONVERSION: "Fixed conversion",
  MEASURE_EACH_DELIVERY: "Measured each delivery",
  COUNT_EACH_DELIVERY: "Counted each delivery",
};

function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const symbol = currency && currency.length <= 3 ? currency : "$";
  return `${symbol}${value.toFixed(2)}`;
}

function date(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function quantityUnit(quantity: number | null, unit: string | null): string {
  if (quantity === null) return "—";
  return unit ? `${quantity} ${unit}` : String(quantity);
}

export function Step4ReviewSend({
  header,
  vendorName,
  preparationStatus,
  deliveryVerifiedByName,
  preparerName,
  preparedAt,
  purchaseDocumentId,
  documentId,
  editable,
  onSend,
  sendPending,
  sendError,
  onNavigateToStep,
  onPreparationStatusChange,
}: {
  header: PurchaseDocumentHeaderDraft;
  vendorName: string | null;
  preparationStatus: PreparationStatus | null;
  deliveryVerifiedByName: string | null;
  preparerName: string | null;
  preparedAt: string | null;
  purchaseDocumentId: string;
  documentId: string;
  /** Whether this is the document's own preparer, actively viewing a
   * still-mutable DRAFT -- mirrors every other step's own editable prop.
   * The "Set Delivery Verifier" control below must never render live for
   * anyone else (a non-preparer viewing someone else's draft, or the
   * preparer looking back at their own already-submitted document) --
   * the backend now rejects it outside DRAFT regardless (see
   * 20260811100059), but the control itself must not even offer the
   * false impression that it would work. */
  editable: boolean;
  onSend: () => void;
  sendPending: boolean;
  sendError: string | null;
  onNavigateToStep: (step: 1 | 2 | 3) => void;
  /** Refetches preparationStatus (and deliveryVerifiedByName) after the
   * inline "Set Delivery Verifier" resolution below succeeds. */
  onPreparationStatusChange: () => void;
}) {
  const [summary, setSummary] = useState<PurchaseDocumentReviewSummary | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [verifierChoice, setVerifierChoice] = useState("");
  const [verifierPending, setVerifierPending] = useState(false);
  const [verifierError, setVerifierError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPurchaseDocumentReviewSummary(purchaseDocumentId).then((result) => {
      if (cancelled || !result.ok) return;
      setSummary(result.summary);
    });
    return () => {
      cancelled = true;
    };
  }, [purchaseDocumentId]);

  const ready = preparationStatus?.ready ?? false;
  const blockers = preparationStatus?.blockers ?? [];
  const missingDeliveryVerifier = blockers.some((b) => /delivery verified/i.test(b.reason));
  const typeLabel = header.documentType ? (DOCUMENT_TYPE_LABEL[header.documentType] ?? header.documentType) : "—";

  useEffect(() => {
    if (!missingDeliveryVerifier) return;
    let cancelled = false;
    listActiveEmployees().then((result) => {
      if (cancelled || !result.ok) return;
      setEmployees(result.employees);
    });
    return () => {
      cancelled = true;
    };
  }, [missingDeliveryVerifier]);

  async function handleSetDeliveryVerifier() {
    if (!verifierChoice) return;
    setVerifierPending(true);
    setVerifierError(null);
    const result = await correctDocumentDeliveryVerifier(documentId, verifierChoice);
    setVerifierPending(false);
    if (!result.ok) {
      setVerifierError(result.message);
      return;
    }
    setVerifierChoice("");
    onPreparationStatusChange();
  }

  const locationsComplete = summary ? summary.receiving.every((r) => r.locationName !== null) : null;
  const exceptionCount = summary?.exceptions.length ?? 0;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{ready ? "Ready for Final Review" : "Almost Ready"}</h2>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <SummaryRow label="Invoice" ok className="✓ Reviewed" />
          <SummaryRow
            label="Items"
            ok={summary ? summary.itemsConfirmedCount === summary.itemsTotalCount : null}
            className={summary ? `${summary.itemsConfirmedCount} / ${summary.itemsTotalCount} resolved` : "Loading…"}
          />
          <SummaryRow
            label="Receiving"
            ok={summary ? summary.receivingCompleteCount === summary.receivingTotalCount : null}
            className={summary ? `${summary.receivingCompleteCount} / ${summary.receivingTotalCount} complete` : "Loading…"}
          />
          <SummaryRow label="Locations" ok={locationsComplete} className={locationsComplete === false ? "Incomplete" : "Complete"} />
          <SummaryRow
            label="Exceptions"
            ok={exceptionCount === 0}
            className={exceptionCount === 0 ? "None" : `${exceptionCount} documented exception${exceptionCount === 1 ? "" : "s"}`}
          />
        </div>
      </div>

      {!ready && blockers.length > 0 ? (
        <div className="rounded-2xl border border-amber-800 bg-amber-950/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            {blockers.length} thing{blockers.length === 1 ? "" : "s"} remaining
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-200">
            {blockers.map((b, i) => (
              <li key={i}>• {b.lineKey ? (b.description ?? "A line") : "This document"} — {b.reason}</li>
            ))}
          </ul>

          {missingDeliveryVerifier && editable ? (
            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-amber-700 bg-zinc-950/40 p-3">
              <label className="flex flex-col gap-1 text-xs text-amber-200">
                Delivery verified by
                <select
                  value={verifierChoice}
                  onChange={(e) => setVerifierChoice(e.target.value)}
                  className="rounded-lg border border-amber-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                >
                  <option value="">Select…</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleSetDeliveryVerifier}
                disabled={!verifierChoice || verifierPending}
                className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40"
              >
                {verifierPending ? "Saving…" : "Set"}
              </button>
              {verifierError ? <p className="w-full text-xs text-red-400">{verifierError}</p> : null}
            </div>
          ) : null}

          {blockers.some((b) => !/delivery verified/i.test(b.reason)) ? (
            <button
              type="button"
              onClick={() =>
                onNavigateToStep(
                  blockers.some((b) => /invoice date/i.test(b.reason))
                    ? 1
                    : blockers.some((b) => /classification|matching|approval|re-review/i.test(b.reason))
                      ? 2
                      : 3
                )
              }
              className="mt-3 rounded-full border border-amber-700 px-4 py-1.5 text-xs font-semibold text-amber-200"
            >
              {blockers.some((b) => /invoice date/i.test(b.reason))
                ? "Go to Review Invoice"
                : blockers.some((b) => /classification|matching|approval|re-review/i.test(b.reason))
                  ? "Go to Confirm Items"
                  : "Go to Receiving"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ============ INVOICE ============ */}
      <Section title="Invoice">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <DetailField label="Vendor" value={vendorName} />
          <DetailField label="Invoice #" value={header.documentNumber} />
          <DetailField label="Document Type" value={typeLabel} />
          <DetailField label="Invoice Date" value={date(header.documentDate)} />
          <DetailField label="Delivery Date" value={date(header.deliveryDate)} />
          <DetailField label="PO #" value={header.poNumber} />
          <DetailField label="Subtotal" value={money(header.subtotal, header.currency)} />
          <DetailField label="Tax" value={money(header.tax, header.currency)} />
          <DetailField label="Fees" value={money(header.fees, header.currency)} />
          <DetailField label="Total" value={money(header.total, header.currency)} emphasize />
        </div>
      </Section>

      {/* ============ PREPARATION ============ */}
      <Section title="Preparation">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <DetailField label="Prepared by" value={preparerName} />
          <DetailField label="Delivery verified by" value={deliveryVerifiedByName} />
          <DetailField label="Last updated" value={preparedAt ? new Date(preparedAt).toLocaleString() : null} />
        </div>
      </Section>

      {/* ============ ITEMS ============ */}
      <Section title="Items" countLabel={summary ? `${summary.itemsConfirmedCount} / ${summary.itemsTotalCount} resolved` : undefined}>
        {summary ? (
          <ul className="flex flex-col divide-y divide-zinc-800">
            {summary.items.map((item) => (
              <li key={item.lineKey} className="flex flex-col gap-0.5 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-zinc-100">{item.description ?? item.vendorSku ?? "—"}</span>
                  {item.status !== "CONFIRMED" ? <span className="text-xs font-semibold text-amber-400">{item.status.replace(/_/g, " ")}</span> : null}
                </div>
                <p className="text-xs text-zinc-500">
                  {item.vendorSku ? `Vendor SKU ${item.vendorSku}` : "No vendor SKU"}
                  {item.canonicalItemName ? ` → ${item.canonicalItemName}` : ""}
                </p>
                {item.disposition === "INVENTORY" ? (
                  <p className="text-xs text-zinc-500">
                    {[item.categoryName, item.baseUnitCode, item.receivingBehavior ? RECEIVING_BEHAVIOR_LABEL[item.receivingBehavior] : null]
                      .filter(Boolean)
                      .join(" · ")}
                    {item.spendCategoryPath ? <span className="block">{item.spendCategoryPath}</span> : null}
                  </p>
                ) : item.disposition === "NON_INVENTORY" ? (
                  <p className="text-xs text-zinc-500">Non-Inventory{item.spendCategoryPath ? ` · ${item.spendCategoryPath}` : ""}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
      </Section>

      {/* ============ RECEIVING ============ */}
      <Section title="Receiving" countLabel={summary ? `${summary.receivingCompleteCount} / ${summary.receivingTotalCount} complete` : undefined}>
        {summary && summary.receiving.length > 0 ? (
          <ul className="flex flex-col divide-y divide-zinc-800">
            {summary.receiving.map((line) => (
              <li key={line.lineKey} className="flex flex-col gap-2 py-3 text-sm">
                <p className="font-medium text-zinc-100">{line.description ?? "—"}</p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <DetailField label="Expected" value={quantityUnit(line.expectedQuantity, line.expectedUnit)} />
                  <DetailField label="Received" value={quantityUnit(line.receivedQuantity, line.receivedUnit)} />
                  {line.inventoryQuantity !== null ? <DetailField label="Inventory Quantity" value={quantityUnit(line.inventoryQuantity, line.verifiedUnit)} /> : null}
                  {line.requiresVerifiedMeasurement ? <DetailField label={`Verified ${line.verifiedUnit ?? ""}`} value={quantityUnit(line.verifiedQuantity, line.verifiedUnit)} /> : null}
                  <DetailField label="Location" value={line.locationName} />
                  <DetailField
                    label="Condition"
                    value={line.conditionStatus === "RECEIVED_AS_INVOICED" ? "As invoiced" : (line.conditionStatus?.replace(/_/g, " ") ?? null)}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : summary ? (
          <p className="text-sm text-zinc-500">No inventory lines to receive.</p>
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
      </Section>

      {/* ============ NON-INVENTORY ============ */}
      {summary && summary.nonInventory.length > 0 ? (
        <Section title="Non-Inventory">
          <ul className="flex flex-col divide-y divide-zinc-800">
            {summary.nonInventory.map((line) => (
              <li key={line.lineKey} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-zinc-100">{line.description ?? "—"}</p>
                  {line.spendCategoryPath ? <p className="text-xs text-zinc-500">Spend Category: {line.spendCategoryPath}</p> : null}
                </div>
                <span className="text-zinc-200">{money(line.lineTotal, header.currency)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ============ EXCEPTIONS ============ */}
      <Section title="Exceptions">
        {summary ? (
          summary.exceptions.length === 0 ? (
            <p className="text-sm text-emerald-400">✓ None</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-amber-200">
              {summary.exceptions.map((exception, i) => (
                <li key={i}>• {exception.message}</li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-sm text-zinc-500">Loading…</p>
        )}
      </Section>

      {sendError ? <p className="text-sm text-red-400">{sendError}</p> : null}

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => onNavigateToStep(3)} className="text-xs text-zinc-400 underline">
          ← Back to Receiving
        </button>
      </div>

      <button
        type="button"
        onClick={onSend}
        disabled={sendPending || !ready}
        title={!ready ? "Resolve the items above before sending for final review." : undefined}
        className="self-start rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
      >
        {sendPending ? "Sending for final review…" : "Send for Final Review"}
      </button>
    </div>
  );
}

function SummaryRow({ label, ok, className }: { label: string; ok: boolean | null; className: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={ok === null ? "text-zinc-500" : ok ? "text-emerald-400" : "text-amber-300"}>
        {ok === null ? "" : ok ? "✓ " : "○ "}
        {className}
      </p>
    </div>
  );
}

function Section({ title, countLabel, children }: { title: string; countLabel?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
        {countLabel ? <span className="text-xs text-zinc-500">{countLabel}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function DetailField({ label, value, emphasize }: { label: string; value: string | null; emphasize?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={emphasize ? "text-base font-semibold text-zinc-100" : "text-sm text-zinc-200"}>{value ?? "—"}</p>
    </div>
  );
}
