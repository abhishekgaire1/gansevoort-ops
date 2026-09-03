"use client";

import { useRef, useState } from "react";
import { formatMoney } from "@/app/lib/formatMoney";
import { SOLE_APPROVER_REASON_OPTIONS, reasonRequiresNotes, isSoleApproverFormValid, type SoleApproverReasonCode } from "@/app/lib/purchaseDocuments/soleApproverReason";

/**
 * Single-manager approval -- the confirmation modal shown when an
 * authorized manager clicks "Post Now as Sole Approver." Deliberately
 * NOT the same visual weight as the primary "Send for Second Review"
 * action it sits beside: the Confirm & Post button below is never the
 * default-focused control (Keep Pending gets initial focus instead), and
 * every fact shown here (vendor/invoice/total/counts/locations) is
 * exactly what the server will independently re-verify and record in the
 * audit trail -- never a claim this modal invents on its own.
 */
export function SoleApproverPostModal({
  vendorName,
  documentNumber,
  invoiceTotal,
  currency,
  inventoryLineCount,
  expenseLineCount,
  inventoryValue,
  locations,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  vendorName: string | null;
  documentNumber: string | null;
  invoiceTotal: number | null;
  currency: string | null;
  inventoryLineCount: number;
  expenseLineCount: number;
  inventoryValue: number;
  locations: string[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { reason: SoleApproverReasonCode; notes: string }) => void;
}) {
  const [reason, setReason] = useState<SoleApproverReasonCode | null>(null);
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const keepPendingRef = useRef<HTMLButtonElement>(null);

  const valid = isSoleApproverFormValid({ reason, notes, acknowledged });

  function handleConfirm() {
    if (!valid || pending || !reason) return;
    onConfirm({ reason, notes: notes.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="sole-approver-title" className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border-2 border-amber-600 bg-zinc-900 p-5">
        <h2 id="sole-approver-title" className="text-lg font-bold text-amber-300">
          Post without independent review?
        </h2>
        <p className="mt-2 text-sm text-zinc-200">
          This invoice has not been reviewed by a second manager. By continuing, you confirm that the item matches, quantities, units, costs and
          receiving details are accurate.
        </p>
        <p className="mt-2 text-sm font-medium text-amber-200">Your name, reason and posting time will be recorded in the audit history as the sole approver.</p>

        <div className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Posting summary</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-zinc-500">Vendor</dt>
            <dd className="text-right text-zinc-100">{vendorName ?? "—"}</dd>
            <dt className="text-zinc-500">Invoice number</dt>
            <dd className="text-right text-zinc-100">{documentNumber ?? "—"}</dd>
            <dt className="text-zinc-500">Invoice total</dt>
            <dd className="text-right text-zinc-100">{formatMoney(invoiceTotal, currency)}</dd>
            <dt className="text-zinc-500">Inventory lines</dt>
            <dd className="text-right text-zinc-100">{inventoryLineCount}</dd>
            <dt className="text-zinc-500">Expense lines</dt>
            <dd className="text-right text-zinc-100">{expenseLineCount}</dd>
            <dt className="text-zinc-500">Inventory value being posted</dt>
            <dd className="text-right text-zinc-100">{formatMoney(inventoryValue, currency)}</dd>
            <dt className="text-zinc-500">Receiving location(s)</dt>
            <dd className="text-right text-zinc-100">{locations.length > 0 ? locations.join(", ") : "—"}</dd>
          </dl>
        </div>

        <label className="mt-4 flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Reason for using single-manager approval
          <select
            value={reason ?? ""}
            onChange={(e) => setReason((e.target.value || null) as SoleApproverReasonCode | null)}
            disabled={pending}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-normal normal-case text-zinc-50"
          >
            <option value="">Select a reason…</option>
            {SOLE_APPROVER_REASON_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Notes {reasonRequiresNotes(reason) ? <span className="text-amber-400">(required)</span> : <span className="text-zinc-600">(optional)</span>}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
            rows={2}
            placeholder={reasonRequiresNotes(reason) ? "Explain why single-manager approval is being used…" : "Add any additional context…"}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-normal normal-case text-zinc-50"
          />
        </label>

        <label className="mt-4 flex items-start gap-2 rounded-lg border border-amber-800 bg-amber-950/20 p-3 text-sm text-amber-100">
          <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
          I understand that I will be recorded as the sole approver responsible for the accuracy of this posting.
        </label>

        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            ref={keepPendingRef}
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={pending}
            className="rounded-full border border-zinc-600 px-5 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-40"
          >
            Keep Pending for Second Review
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || pending}
            className="rounded-full border-2 border-amber-500 bg-amber-500/10 px-5 py-2 text-sm font-bold text-amber-300 disabled:opacity-40"
          >
            {pending ? "Posting…" : "Confirm & Post as Sole Approver"}
          </button>
        </div>
      </div>
    </div>
  );
}
