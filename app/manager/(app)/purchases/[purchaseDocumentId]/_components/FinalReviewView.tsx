"use client";

import { useCallback, useEffect, useState } from "react";
import { verifyPurchaseDocument, returnPurchaseDocumentToDraft, getPurchaseDocumentPreparationStatus } from "@/app/actions/purchaseDocuments";
import { MismatchNote } from "./DocumentFields";
import { ItemMappingPanel } from "./ItemMappingPanel";
import { ReceivingPanel } from "./ReceivingPanel";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { VendorSummary } from "@/app/actions/vendors";

const DOCUMENT_TYPE_LABEL: Record<PurchaseDocumentType, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

/**
 * The second manager's final-review experience -- a fresh pair of eyes,
 * strictly read-only. Manager 2 is not the person who prepared this
 * document and must not casually mutate Manager 1's preparation and then
 * verify their own changes -- that defeats the whole point of a second
 * reviewer. Every section here (Invoice, Item mappings, Receiving) is
 * display-only; the only two actions are RETURN TO PREPARER (send it
 * back for Manager 1 to fix) and FINAL VERIFY. If Manager 2 spots a
 * problem, they return it -- they do not fix it themselves.
 */
export function FinalReviewView({
  purchaseDocumentId,
  version,
  header,
  lines,
  vendors,
  vendorName,
  declaredVendorName,
  aiSuggestedVendorName,
  declaredDocumentType,
  aiSuggestedDocumentType,
  deliveryVerifiedByName,
  onReturned,
  onVerified,
}: {
  purchaseDocumentId: string;
  version: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  submittedHeader: PurchaseDocumentHeaderDraft;
  submittedLines: PurchaseDocumentLine[];
  vendors: VendorSummary[];
  vendorName: string | null;
  declaredVendorName: string | null;
  aiSuggestedVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  deliveryVerifiedByName: string | null;
  onReturned: () => void;
  onVerified: () => void;
}) {
  const [verifyPending, setVerifyPending] = useState(false);
  const [returnPending, setReturnPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [preparationStatus, setPreparationStatus] = useState<PreparationStatus | null>(null);

  const refetchPreparationStatus = useCallback(async () => {
    const result = await getPurchaseDocumentPreparationStatus(purchaseDocumentId);
    if (result.ok) setPreparationStatus(result.status);
  }, [purchaseDocumentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchPreparationStatus();
  }, [refetchPreparationStatus]);

  async function handleVerify() {
    setVerifyPending(true);
    setActionError(null);
    // No header/lines payload -- Manager 2 never submits edits here.
    // Final Verify only ever verifies exactly what Manager 1 prepared.
    const result = await verifyPurchaseDocument(purchaseDocumentId, version);
    setVerifyPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    onVerified();
  }

  async function handleReturn() {
    setReturnPending(true);
    setActionError(null);
    const result = await returnPurchaseDocumentToDraft(purchaseDocumentId, version, returnReason || undefined);
    setReturnPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    onReturned();
  }

  const typeLabel = header.documentType ? DOCUMENT_TYPE_LABEL[header.documentType] : "—";

  return (
    <div className="mt-4 flex flex-col gap-6">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Invoice</h2>

        <MismatchNote label="Vendor" declared={declaredVendorName} aiSuggested={aiSuggestedVendorName} current={vendors.find((v) => v.id === header.vendorId)?.name ?? vendorName} />
        <MismatchNote label="Document type" declared={declaredDocumentType} aiSuggested={aiSuggestedDocumentType} current={header.documentType} />

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <DetailField label="Vendor" value={vendors.find((v) => v.id === header.vendorId)?.name ?? vendorName} />
          <DetailField label="Document type" value={typeLabel} />
          <DetailField label={header.documentType ? `${DOCUMENT_TYPE_LABEL[header.documentType]} #` : "Document #"} value={header.documentNumber} />
          <DetailField label="Document date" value={header.documentDate ? new Date(header.documentDate).toLocaleDateString() : null} />
          <DetailField label="PO #" value={header.poNumber} />
          <DetailField label="Delivery date" value={header.deliveryDate ? new Date(header.deliveryDate).toLocaleDateString() : null} />
          <DetailField label="Subtotal" value={money(header.subtotal)} />
          <DetailField label="Tax" value={money(header.tax)} />
          <DetailField label="Fees" value={money(header.fees)} />
          <DetailField label="Total" value={money(header.total)} />
        </div>

        <p className="mt-4 text-xs uppercase tracking-wide text-zinc-500">Lines ({lines.length})</p>
        <div className="mt-2 flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {lines.map((line, index) => (
            <div key={line.lineKey ?? index} className="p-3 text-sm">
              <p className="text-zinc-100">{line.description ?? "—"}</p>
              <p className="text-xs text-zinc-500">
                {line.vendorSku ? `SKU ${line.vendorSku} · ` : ""}
                {line.packageQuantity ?? "—"} {line.packageUnit ?? ""} · {money(line.lineTotal)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Item Mappings</h2>
        <ItemMappingPanel purchaseDocumentId={purchaseDocumentId} vendorName={vendorName} readOnly onChange={refetchPreparationStatus} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Receiving</h2>
        <ReceivingPanel purchaseDocumentId={purchaseDocumentId} readOnly onChange={refetchPreparationStatus} />
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Exceptions</h2>
        {preparationStatus === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : preparationStatus.blockers.length === 0 ? (
          <p className="text-sm text-emerald-400">None.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-amber-300">
            {preparationStatus.blockers.map((b, i) => (
              <li key={i}>
                • {b.lineKey ? (b.description ?? "A line") : "This document"} — {b.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      {deliveryVerifiedByName ? (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Delivery Verified By</h2>
          <p className="text-sm text-zinc-200">{deliveryVerifiedByName}</p>
        </section>
      ) : null}

      {actionError ? <p className="text-sm text-red-400">{actionError}</p> : null}

      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs text-zinc-500">If something needs to change, return it to the preparer rather than editing it here.</p>
        <input
          type="text"
          value={returnReason}
          onChange={(event) => setReturnReason(event.target.value)}
          placeholder="Reason for returning (optional)"
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleReturn}
            disabled={verifyPending || returnPending}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            {returnPending ? "Returning to preparer…" : "Return to Preparer"}
          </button>
          <button
            type="button"
            onClick={handleVerify}
            disabled={verifyPending || returnPending}
            className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
          >
            {verifyPending ? "Final verifying…" : "Final Verify"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm text-zinc-200">{value ?? "—"}</p>
    </div>
  );
}
