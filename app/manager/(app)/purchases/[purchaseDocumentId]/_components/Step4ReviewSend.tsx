"use client";

import { useEffect, useState } from "react";
import { getPurchaseDocumentReviewSummary } from "@/app/actions/purchaseDocuments";
import { listActiveEmployees, correctDocumentDeliveryVerifier, type EmployeeSummary } from "@/app/actions/receiving";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";
import { buildFinalReviewRows, type FinalReviewRow } from "@/app/lib/purchaseDocuments/finalReviewTable";
import { deriveSendActionState } from "@/app/lib/purchaseDocuments/sendActionState";
import { formatMoney } from "@/app/lib/formatMoney";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";

/**
 * Step 4 -- Manager 1's final check before submission. Three layers, each
 * shown exactly ONCE (the previous layout repeated every line name across
 * separate Items/Receiving/Non-Inventory sections):
 *   1. A compact readiness strip -- driven ENTIRELY by preparationStatus,
 *      the same RPC-enforced rule submit_purchase_document_for_verification
 *      itself uses. Never recomputed here.
 *   2. A compact document grid (header + preparation facts).
 *   3. ONE consolidated read-only line table -- invoice commercials
 *      (qty/unit/price/total) side by side with mapping and effective
 *      receiving facts, merged by buildFinalReviewRows from the SAME
 *      authoritative read models the gates use (no new calculations).
 * Nothing here is editable; a manager who spots a problem navigates back
 * via the stepper/back links to fix it, and this summary refreshes on
 * return.
 */

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

function date(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

const STATUS_BADGE_CLASS: Record<FinalReviewRow["status"]["kind"], string> = {
  ready: "bg-emerald-400/10 text-emerald-300",
  needs_review: "bg-amber-400/10 text-amber-300",
  exception: "bg-orange-400/10 text-orange-300",
};

export function Step4ReviewSend({
  header,
  lines,
  documentStatus,
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
  /** The current draft lines exactly as they will be submitted -- the
   * authoritative source for the table's commercial columns. */
  lines: PurchaseDocumentLine[];
  /** Lifecycle truth for the primary action: Send exists only while
   * DRAFT; once READY_FOR_VERIFICATION the button becomes an inert
   * "✓ Sent" state (Withdraw Submission is the separate explicit action
   * to take it back). The submit RPC remains the integrity boundary. */
  documentStatus: "DRAFT" | "READY_FOR_VERIFICATION";
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
  const rows = buildFinalReviewRows({ lines, summary, blockers });
  const sendAction = deriveSendActionState({ status: documentStatus, editable, ready });

  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* ============ COMPACT READINESS STRIP ============ */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{ready ? "Ready for Final Review" : "Almost Ready"}</h2>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <SummaryRow label="Invoice" ok className="Reviewed" />
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
            className={exceptionCount === 0 ? "None" : `${exceptionCount} documented`}
          />
          <SummaryRow label="Delivery verifier" ok={!missingDeliveryVerifier} className={missingDeliveryVerifier ? "Missing" : (deliveryVerifiedByName ?? "Set")} />
        </div>
      </div>

      {/* ============ COMPACT DOCUMENT GRID ============ */}
      <Section title="Document">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <DetailField label="Vendor" value={vendorName} />
          <DetailField label={`${typeLabel} #`} value={header.documentNumber} />
          <DetailField label="Document Type" value={typeLabel} />
          <DetailField label="Invoice Date" value={date(header.documentDate)} />
          <DetailField label="Delivery Date" value={date(header.deliveryDate)} />
          <DetailField label="PO #" value={header.poNumber} />
          <DetailField label="Prepared by" value={preparerName} />
          <DetailField label="Delivery verified by" value={deliveryVerifiedByName} />
          <DetailField label="Subtotal" value={formatMoney(header.subtotal, header.currency)} />
          <DetailField label="Tax" value={formatMoney(header.tax, header.currency)} />
          <DetailField label="Fees" value={formatMoney(header.fees, header.currency)} />
          <DetailField label="Total" value={formatMoney(header.total, header.currency)} emphasize />
          <DetailField label="Last updated" value={preparedAt ? new Date(preparedAt).toLocaleString() : null} />
        </div>
      </Section>

      {/* ============ THE CONSOLIDATED LINE REVIEW ============ */}
      <Section
        title="Line Review"
        countLabel={
          summary
            ? `${summary.itemsTotalCount} lines · ${summary.itemsConfirmedCount} resolved · ${summary.receivingCompleteCount}/${summary.receivingTotalCount} received`
            : undefined
        }
      >
        {exceptionCount > 0 ? (
          <ul className="mb-3 flex flex-col gap-1 rounded-lg border border-amber-900 bg-amber-950/20 p-3 text-xs text-amber-200">
            {summary!.exceptions.map((exception, index) => (
              <li key={index}>• {exception.message}</li>
            ))}
          </ul>
        ) : null}

        {summary === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="max-h-[32rem] overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-zinc-950 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-normal">Type</th>
                  <th className="px-3 py-2 font-normal">SKU</th>
                  <th className="px-3 py-2 font-normal">Item</th>
                  <th className="px-3 py-2 font-normal">Matched Item</th>
                  <th className="px-3 py-2 text-right font-normal">Qty</th>
                  <th className="px-3 py-2 font-normal">Unit</th>
                  <th className="px-3 py-2 text-right font-normal">Unit Price</th>
                  <th className="px-3 py-2 text-right font-normal">Line Total</th>
                  <th className="px-3 py-2 font-normal">Received</th>
                  <th className="px-3 py-2 font-normal">Inventory Qty</th>
                  <th className="px-3 py-2 font-normal">Location</th>
                  <th className="px-3 py-2 font-normal">Condition</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map((row, index) => (
                  <tr key={row.lineKey ?? index} className="align-top">
                    <td className="px-3 py-2 text-xs text-zinc-400">{row.typeLabel}</td>
                    <td className="px-3 py-2 text-xs text-zinc-400">{row.sku ?? "—"}</td>
                    <td className="max-w-56 px-3 py-2">
                      <p className="text-zinc-100">{row.description ?? "—"}</p>
                      {row.secondary ? <p className="mt-0.5 text-xs text-zinc-500">{row.secondary}</p> : null}
                    </td>
                    <td className="max-w-52 px-3 py-2 text-zinc-300">{row.matchedLabel ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-zinc-200">{row.quantity ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-400">{row.unit ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{formatMoney(row.unitPrice, header.currency)}</td>
                    <td className="px-3 py-2 text-right text-zinc-100">{formatMoney(row.lineTotal, header.currency)}</td>
                    <td className="px-3 py-2 text-zinc-200">{row.receivedLabel ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-300">{row.inventoryQuantityLabel ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-300">{row.locationName ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-400">{row.conditionLabel ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE_CLASS[row.status.kind]}`}
                        title={row.problems.length > 0 ? row.problems.join("\n") : undefined}
                      >
                        {row.status.kind === "ready" ? "✓ Ready" : row.status.label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ============ BLOCKERS -- NEXT TO THE PRIMARY ACTION ============ */}
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
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-700 bg-zinc-950/40 p-3">
              <p className="text-xs text-amber-200/80">Who physically checked this delivery before the invoice was entered?</p>
              <div className="flex flex-wrap items-end gap-2">
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
              </div>
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
                  : "Go to Confirm Receiving"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ============ ACTIONS ============ */}
      {sendAction.kind === "send" ? (
        <>
          {sendError ? <p className="text-sm text-red-400">{sendError}</p> : null}
          <WorkflowFooter
            onBack={() => onNavigateToStep(3)}
            backLabel="Back to Confirm Receiving"
            contextLabel={!sendAction.enabled ? "Resolve the items above before sending" : undefined}
            contextTone="warning"
            primaryLabel="Send for Final Review"
            onPrimary={onSend}
            primaryDisabled={!sendAction.enabled}
            primaryPending={sendPending}
            primaryPendingLabel="Sending for Final Review…"
            primaryTitle={!sendAction.enabled ? "Resolve the items above before sending for final review." : undefined}
            sticky={false}
          />
        </>
      ) : sendAction.kind === "sent" ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/95 px-4 py-3">
          <button type="button" onClick={() => onNavigateToStep(3)} className="text-xs text-zinc-400 underline">
            ← Back to Confirm Receiving
          </button>
          <div className="flex flex-col items-end gap-0.5">
            {/* Status Language -- Verification, Part "SUCCESS MESSAGE": this
                inert state IS the submitting manager's success confirmation
                in this app's design (no separate toast/modal exists) --
                "Sent," never "Ready," since they just sent it. */}
            <span className="inline-flex cursor-default items-center gap-2 self-end rounded-full border border-emerald-800 bg-emerald-950/30 px-6 py-2 text-sm font-semibold text-emerald-300">
              ✓ Sent for Verification
            </span>
            <span className="text-xs text-zinc-500">
              Your review is complete. Another manager can now verify this document.
              {editable === false ? " Use Withdraw Submission above to make changes." : ""}
            </span>
          </div>
        </div>
      ) : null}
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
