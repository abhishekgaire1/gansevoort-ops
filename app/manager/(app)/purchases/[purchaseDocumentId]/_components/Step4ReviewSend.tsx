"use client";

import { useEffect, useMemo, useState } from "react";
import { getPurchaseDocumentReviewSummary, canUseSoleApproverPosting, postPurchaseDocumentSoleApprover, getAmendmentAlreadyPosted } from "@/app/actions/purchaseDocuments";
import { listActiveEmployees, correctDocumentDeliveryVerifier, type EmployeeSummary } from "@/app/actions/receiving";
import { getPurchaseDocumentPriceReviewAction, type GetPriceReviewResult } from "@/app/actions/priceReview";
import type { LineClassificationRow } from "@/app/actions/itemClassification";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";
import { deriveSendActionState } from "@/app/lib/purchaseDocuments/sendActionState";
import type { SoleApproverReasonCode } from "@/app/lib/purchaseDocuments/soleApproverReason";
import { postPrimaryLabel, type ReadinessSummary } from "@/app/lib/purchaseDocuments/lineReadiness";
import { LINE_TREATMENT_LABEL, CREDIT_SUBTYPE_LABEL, signedLineAmount } from "@/app/lib/purchaseDocuments/lineTreatment";
import { reconcileTotals } from "@/app/lib/purchaseDocuments/totalsReconciliation";
import { formatMoney } from "@/app/lib/formatMoney";
import { WorkflowFooter } from "@/app/components/receiving/WorkflowFooter";
import { SoleApproverPostModal } from "./SoleApproverPostModal";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableHeadCellRightClass, tableRowClass, tableCellClass, tableCellRightClass, tableCellMutedClass } from "@/app/components/manager/surfaces";
import { textLinkClass } from "@/app/components/manager/buttonStyles";

/**
 * Step 3 -- Review & Post. Separate, truthful summaries per treatment
 * (inventory to receive / inventory returns / expenses / credits &
 * discounts / taxes & charges), a totals reconciliation across all line
 * types, the inventory-impact panel, and the same readiness the Stepper
 * and Step 2 use. The primary action is the authorized manager's post
 * ("Post invoice & inventory" when inventory changes exist, "Post
 * invoice" otherwise -- never "Post to inventory" for an expense-only
 * invoice); Send for Final Review remains the second-reviewer route.
 * Nothing here is editable; every fact comes from the authoritative read
 * models (classification rows, effective receipts, preparation status).
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

export function Step4ReviewSend({
  header,
  lines,
  classificationRows,
  readinessSummary,
  documentStatus,
  version,
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
  onPostedSoleApprover,
}: {
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  /** The authoritative classification rows (null while loading). */
  classificationRows: LineClassificationRow[] | null;
  /** THE shared readiness summary (lineReadiness.ts). */
  readinessSummary: ReadinessSummary;
  documentStatus: "DRAFT" | "READY_FOR_VERIFICATION";
  version: number;
  vendorName: string | null;
  preparationStatus: PreparationStatus | null;
  deliveryVerifiedByName: string | null;
  preparerName: string | null;
  preparedAt: string | null;
  purchaseDocumentId: string;
  documentId: string;
  editable: boolean;
  onSend: () => void;
  sendPending: boolean;
  sendError: string | null;
  onNavigateToStep: (step: 1 | 2, lineKey?: string | null) => void;
  onPostedSoleApprover: () => void;
  onPreparationStatusChange: () => void;
}) {
  const [summary, setSummary] = useState<PurchaseDocumentReviewSummary | null>(null);
  const [priceReview, setPriceReview] = useState<Extract<GetPriceReviewResult, { ok: true }> | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [verifierChoice, setVerifierChoice] = useState("");
  const [verifierPending, setVerifierPending] = useState(false);
  const [verifierError, setVerifierError] = useState<string | null>(null);
  const [soleApproverEligible, setSoleApproverEligible] = useState(false);
  const [soleApproverModalOpen, setSoleApproverModalOpen] = useState(false);
  const [soleApproverPending, setSoleApproverPending] = useState(false);
  const [soleApproverError, setSoleApproverError] = useState<string | null>(null);
  const [soleApproverBlockers, setSoleApproverBlockers] = useState<{ description: string | null; reason: string }[]>([]);
  const [amendmentAlreadyPosted, setAmendmentAlreadyPosted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPurchaseDocumentReviewSummary(purchaseDocumentId).then((result) => {
      if (cancelled || !result.ok) return;
      setSummary(result.summary);
    });
    getPurchaseDocumentPriceReviewAction(purchaseDocumentId).then((result) => {
      if (cancelled || !result.ok) return;
      setPriceReview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [purchaseDocumentId]);

  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    canUseSoleApproverPosting().then((result) => {
      if (cancelled || !result.ok) return;
      setSoleApproverEligible(result.eligible);
    });
    getAmendmentAlreadyPosted(purchaseDocumentId).then((result) => {
      if (cancelled || !result.ok) return;
      setAmendmentAlreadyPosted(result.alreadyPosted);
    });
    return () => {
      cancelled = true;
    };
  }, [editable, purchaseDocumentId]);

  async function handleConfirmSoleApprover({ reason, notes }: { reason: SoleApproverReasonCode; notes: string }) {
    if (soleApproverPending) return;
    setSoleApproverPending(true);
    setSoleApproverError(null);
    setSoleApproverBlockers([]);
    const result = await postPurchaseDocumentSoleApprover({
      purchaseDocumentId,
      expectedVersion: version,
      reason,
      notes: notes || null,
      // A fresh key per attempt; the database converges a retry on the
      // existing posting (unique receipt_line_id / classification_id).
      idempotencyKey: crypto.randomUUID(),
    });
    setSoleApproverPending(false);
    if (!result.ok) {
      const reference = "reference" in result && result.reference ? result.reference : null;
      const correlationId = "correlationId" in result && result.correlationId ? result.correlationId : null;
      const suffix = reference ? ` (Reference: ${reference})` : correlationId ? ` (Reference: ${correlationId})` : "";
      setSoleApproverError(`${result.message}${suffix}`);
      if (result.reason === "blocked") {
        setSoleApproverBlockers(result.blockers.map((b) => ({ description: b.description, reason: b.reason })));
      }
      return;
    }
    setSoleApproverModalOpen(false);
    onPostedSoleApprover();
  }

  const ready = preparationStatus?.ready ?? false;
  const blockers = preparationStatus?.blockers ?? [];
  const hasDeliveryConflict = blockers.some((b) => /recorded deliveries|delivery records|separate physical deliveries/i.test(b.reason));
  const missingDeliveryVerifier = blockers.some((b) => /delivery verified/i.test(b.reason));
  const typeLabel = header.documentType ? (DOCUMENT_TYPE_LABEL[header.documentType] ?? header.documentType) : "—";
  const currency = header.currency;

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

  // ---- Per-treatment summaries from the authoritative rows ----
  const rows = useMemo(() => classificationRows ?? [], [classificationRows]);
  const rowByLineKey = useMemo(() => new Map(rows.map((r) => [r.lineKey, r])), [rows]);
  const lineByKey = useMemo(() => new Map(lines.filter((l) => l.lineKey).map((l) => [l.lineKey as string, l])), [lines]);
  const receivingByLineKey = useMemo(() => new Map((summary?.receiving ?? []).map((r) => [r.lineKey, r])), [summary]);
  const priceStateByLineKey = useMemo(() => new Map((priceReview?.lines ?? []).map((l) => [l.lineKey, l.state])), [priceReview]);

  const inventoryRows = rows.filter((r) => r.lineTreatment === "INVENTORY_PURCHASE");
  const returnRows = rows.filter((r) => r.lineTreatment === "CREDIT_RETURN" && r.creditSubtype === "INVENTORY_RETURN");
  const expenseRows = rows.filter((r) => r.lineTreatment === "EXPENSE" || r.lineTreatment === "FREIGHT_FEE");
  const creditRows = rows.filter((r) => r.lineTreatment === "DISCOUNT" || (r.lineTreatment === "CREDIT_RETURN" && r.creditSubtype !== "INVENTORY_RETURN"));
  const taxRows = rows.filter((r) => r.lineTreatment === "TAX");
  const unresolvedRows = rows.filter((r) => r.lineTreatment === "UNRESOLVED" || r.status === "UNCLASSIFIED");

  const totals = useMemo(
    () => reconcileTotals(lines.map((l) => ({ treatment: (l.lineKey && rowByLineKey.get(l.lineKey)?.lineTreatment) || "UNRESOLVED", lineTotal: l.lineTotal })), { tax: header.tax, fees: header.fees, total: header.total }),
    [lines, rowByLineKey, header.tax, header.fees, header.total]
  );

  const hasInventoryChanges = readinessSummary.hasInventoryChanges || inventoryRows.length > 0 || returnRows.length > 0;
  const primaryLabel = postPrimaryLabel(hasInventoryChanges);
  const sendAction = deriveSendActionState({ status: documentStatus, editable, ready });
  const inventoryValue = inventoryRows.reduce((sum, r) => sum + (r.lineTotal ?? 0), 0);
  const soleApproverLocations = Array.from(new Set((summary?.receiving ?? []).map((r) => r.locationName).filter((name): name is string => Boolean(name))));
  const totalInventoryIncrease = (summary?.receiving ?? []).reduce<Record<string, number>>((acc, r) => {
    const qty = r.inventoryQuantity ?? (r.requiresVerifiedMeasurement ? r.verifiedQuantity : r.receivedQuantity);
    const unit = r.inventoryQuantity !== null || r.requiresVerifiedMeasurement ? r.verifiedUnit : r.receivedUnit;
    if (qty === null || !unit) return acc;
    acc[unit] = (acc[unit] ?? 0) + qty;
    return acc;
  }, {});

  const priceStateLabel = (lineKey: string): string => {
    const state = priceStateByLineKey.get(lineKey);
    switch (state) {
      case "ACKNOWLEDGED":
        return "Reviewed";
      case "REQUIRES_ACKNOWLEDGMENT":
        return "Needs review";
      case "INFORMATIONAL_CHANGE":
        return "Change noted";
      case "NO_MATERIAL_CHANGE":
        return "No material change";
      case "NO_COMPARABLE_HISTORY":
        return "No prior purchase";
      default:
        return "—";
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* ============ READINESS STRIP ============ */}
      <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>{ready ? "Ready to post" : "Almost ready"}</h2>
          <span className={panelMetaClass}>{readinessSummary.totalLines} line{readinessSummary.totalLines === 1 ? "" : "s"} · {readinessSummary.readyCount} ready</span>
        </div>
        <div className={`${panelBodyClass} grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3 lg:grid-cols-6`}>
          <SummaryRow label="Classification" ok={unresolvedRows.length === 0 && readinessSummary.allClassified} text={unresolvedRows.length === 0 ? "Complete" : `${unresolvedRows.length} unclassified`} />
          <SummaryRow label="Inventory" ok={inventoryRows.length === 0 || (summary ? summary.receivingCompleteCount === summary.receivingTotalCount : null)} text={inventoryRows.length === 0 ? "No inventory lines" : summary ? `${summary.receivingCompleteCount} / ${summary.receivingTotalCount} received` : "Loading…"} />
          <SummaryRow label="Returns" ok={returnRows.length === 0 || readinessSummary.inventoryReturnCount === returnRows.length} text={returnRows.length === 0 ? "None" : `${returnRows.length} to post`} />
          <SummaryRow label="Expenses" ok={expenseRows.every((r) => r.spendCategoryId && r.spendCategoryActive !== false)} text={expenseRows.length === 0 ? "None" : `${expenseRows.length} categorized`} />
          <SummaryRow label="Exceptions" ok={(summary?.exceptions.length ?? 0) === 0} text={(summary?.exceptions.length ?? 0) === 0 ? "None" : `${summary!.exceptions.length} documented`} />
          <SummaryRow label="Responsible manager" ok={!missingDeliveryVerifier} text={missingDeliveryVerifier ? "Missing" : (deliveryVerifiedByName ?? (inventoryRows.length === 0 ? "Not required" : "Set"))} />
        </div>
      </div>

      {/* ============ PRICE REVIEW ============ */}
      {priceReview && (priceReview.requiresAckLineKeys.length > 0 || priceReview.acknowledgedCount > 0 || priceReview.informationalCount > 0) ? (
        <Section title="Price review">
          {priceReview.requiresAckLineKeys.length > 0 ? (
            <div className="rounded-lg border border-red-800/70 bg-red-950/20 px-3 py-2 text-sm text-red-200">
              <p className="font-medium">{priceReview.requiresAckLineKeys.length} price change{priceReview.requiresAckLineKeys.length === 1 ? "" : "s"} still require{priceReview.requiresAckLineKeys.length === 1 ? "s" : ""} review.</p>
              <p className="mt-0.5 text-red-300/90">Return to Items &amp; Receiving before posting.</p>
            </div>
          ) : priceReview.acknowledgedCount > 0 ? (
            <p className="text-sm font-medium text-emerald-300">✓ {priceReview.acknowledgedCount} significant price change{priceReview.acknowledgedCount === 1 ? "" : "s"} reviewed</p>
          ) : null}
          {priceReview.informationalCount > 0 ? <p className="mt-2 text-sm text-zinc-400">{priceReview.informationalCount} informational price change{priceReview.informationalCount === 1 ? "" : "s"} noted.</p> : null}
        </Section>
      ) : null}

      {/* ============ DOCUMENT ============ */}
      <Section title="Document">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <DetailField label="Vendor" value={vendorName} />
          <DetailField label={`${typeLabel} #`} value={header.documentNumber} />
          <DetailField label="Document type" value={typeLabel} />
          <DetailField label="Invoice date" value={date(header.documentDate)} />
          <DetailField label="Delivery date" value={date(header.deliveryDate)} />
          <DetailField label="PO #" value={header.poNumber} />
          <DetailField label="Prepared by" value={preparerName} />
          <DetailField label="Delivery verified by" value={deliveryVerifiedByName} />
          <DetailField label="Invoice total" value={formatMoney(header.total, currency)} emphasize />
          <DetailField label="Last updated" value={preparedAt ? new Date(preparedAt).toLocaleString() : null} />
        </div>
      </Section>

      {/* ============ INVENTORY TO RECEIVE ============ */}
      {inventoryRows.length > 0 ? (
        <Section title="Inventory to receive" countLabel={`${inventoryRows.length} line${inventoryRows.length === 1 ? "" : "s"}`}>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Item</th>
                  <th className={tableHeadCellClass}>Invoice quantity</th>
                  <th className={tableHeadCellClass}>Applied purchase package</th>
                  <th className={tableHeadCellClass}>Normalized quantity</th>
                  <th className={tableHeadCellClass}>Location</th>
                  <th className={tableHeadCellClass}>Inventory change</th>
                  <th className={tableHeadCellClass}>Price review</th>
                  <th className={tableHeadCellRightClass}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {inventoryRows.map((r) => {
                  const rec = receivingByLineKey.get(r.lineKey);
                  const line = lineByKey.get(r.lineKey);
                  const pkg = r.effectiveReceivingBehavior === "FIXED_CONVERSION" && r.effectiveConversionFactor && r.inventoryBaseUnitCode
                    ? `1 ${r.effectivePurchaseUnitCode ?? ""} = ${r.effectiveConversionFactor} ${r.inventoryBaseUnitCode}`
                    : r.effectiveReceivingBehavior === "MEASURE_EACH_DELIVERY" || r.effectiveReceivingBehavior === "COUNT_EACH_DELIVERY"
                      ? `${r.effectivePurchaseUnitCode ?? ""} · measured each delivery`
                      : r.effectivePurchaseUnitCode ?? r.inventoryBaseUnitCode ?? "—";
                  const normalized = rec ? (rec.inventoryQuantity !== null ? `${rec.inventoryQuantity} ${rec.verifiedUnit ?? ""}` : rec.requiresVerifiedMeasurement && rec.verifiedQuantity !== null ? `${rec.verifiedQuantity} ${rec.verifiedUnit ?? ""}` : rec.receivedQuantity !== null ? `${rec.receivedQuantity} ${rec.receivedUnit ?? ""}` : "—") : "—";
                  return (
                    <tr key={r.lineKey} className={tableRowClass}>
                      <td className={tableCellClass}>
                        <p className="text-zinc-100">{r.inventoryItemName ?? "—"}</p>
                        <p className="text-xs text-zinc-500">{r.description}</p>
                      </td>
                      <td className={tableCellClass}>{line ? `${line.packageQuantity ?? line.measuredQuantity ?? "—"} ${(line.packageQuantity !== null ? line.packageUnit : line.measuredUnit) ?? ""}`.trim() : "—"}</td>
                      <td className={tableCellClass}>{pkg}</td>
                      <td className={tableCellClass}>{normalized}</td>
                      <td className={tableCellClass}>{rec?.locationName ?? "—"}</td>
                      <td className={`${tableCellClass} font-medium text-emerald-300`}>{normalized !== "—" ? `+${normalized}` : "—"}</td>
                      <td className={tableCellMutedClass}>{priceStateLabel(r.lineKey)}</td>
                      <td className={tableCellRightClass}>{formatMoney(r.lineTotal, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {/* ============ INVENTORY RETURNS ============ */}
      {returnRows.length > 0 ? (
        <Section title="Inventory returns" countLabel={`${returnRows.length} line${returnRows.length === 1 ? "" : "s"}`}>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Item</th>
                  <th className={tableHeadCellClass}>Quantity leaving</th>
                  <th className={tableHeadCellClass}>Source location</th>
                  <th className={tableHeadCellClass}>On hand before → after</th>
                  <th className={tableHeadCellClass}>Reason</th>
                  <th className={tableHeadCellRightClass}>Credit amount</th>
                </tr>
              </thead>
              <tbody>
                {returnRows.map((r) => (
                  <tr key={r.lineKey} className={tableRowClass}>
                    <td className={tableCellClass}>
                      <p className="text-zinc-100">{r.inventoryItemName ?? "—"}</p>
                      <p className="text-xs text-zinc-500">{r.description}</p>
                    </td>
                    <td className={`${tableCellClass} font-medium text-sky-300`}>−{r.returnBaseQuantity ?? r.returnQuantity ?? "—"} {r.inventoryBaseUnitCode ?? r.returnUnitCode ?? ""}</td>
                    <td className={tableCellClass}>{r.returnLocationName ?? "—"}</td>
                    <td className={tableCellClass}>
                      {r.returnOnHandQuantity !== null && r.returnBaseQuantity !== null ? `${r.returnOnHandQuantity} → ${r.returnOnHandQuantity - r.returnBaseQuantity} ${r.inventoryBaseUnitCode ?? ""}` : "—"}
                    </td>
                    <td className={tableCellMutedClass}>{r.returnReason ?? "—"}</td>
                    <td className={`${tableCellRightClass} text-sky-300`}>{formatMoney(signedLineAmount("CREDIT_RETURN", r.lineTotal), currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {/* ============ EXPENSES ============ */}
      {expenseRows.length > 0 ? (
        <Section title="Expense summary" countLabel="Recorded as expenses · no inventory">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Description</th>
                  <th className={tableHeadCellClass}>Category</th>
                  <th className={tableHeadCellClass}>Type</th>
                  <th className={tableHeadCellRightClass}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {expenseRows.map((r) => (
                  <tr key={r.lineKey} className={tableRowClass}>
                    <td className={tableCellClass}>{r.description ?? "—"}</td>
                    <td className={tableCellClass}>{r.spendCategoryName ?? <span className="text-amber-300">No category</span>}</td>
                    <td className={tableCellMutedClass}>{LINE_TREATMENT_LABEL[r.lineTreatment]}</td>
                    <td className={tableCellRightClass}>{formatMoney(r.lineTotal, currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className={`${tableCellClass} text-right font-semibold`}>Total expenses</td>
                  <td className={`${tableCellRightClass} font-semibold text-zinc-100`}>{formatMoney(expenseRows.reduce((s, r) => s + (r.lineTotal ?? 0), 0), currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Inventory impact: none.</p>
        </Section>
      ) : null}

      {/* ============ CREDITS & DISCOUNTS ============ */}
      {creditRows.length > 0 ? (
        <Section title="Credits & discounts" countLabel={`${creditRows.length} line${creditRows.length === 1 ? "" : "s"}`}>
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Description</th>
                  <th className={tableHeadCellClass}>Type</th>
                  <th className={tableHeadCellRightClass}>Amount</th>
                  <th className={tableHeadCellClass}>Inventory effect</th>
                </tr>
              </thead>
              <tbody>
                {creditRows.map((r) => (
                  <tr key={r.lineKey} className={tableRowClass}>
                    <td className={tableCellClass}>{r.description ?? "—"}{r.vendorSku ? <span className="text-xs text-zinc-500"> · SKU {r.vendorSku}</span> : null}</td>
                    <td className={tableCellMutedClass}>
                      {r.lineTreatment === "DISCOUNT" ? (r.discountScope === "DOCUMENT" ? "Document discount" : "Line discount") : r.creditSubtype ? `Vendor credit · ${CREDIT_SUBTYPE_LABEL[r.creditSubtype]}` : "Vendor credit"}
                    </td>
                    <td className={`${tableCellRightClass} text-sky-300`}>{formatMoney(signedLineAmount(r.lineTreatment, r.lineTotal), currency)}</td>
                    <td className={tableCellMutedClass}>None</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {/* ============ TAXES & CHARGES ============ */}
      {taxRows.length > 0 || totals.usedHeaderTax ? (
        <Section title="Taxes & charges">
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead className={tableHeadClass}>
                <tr>
                  <th className={tableHeadCellClass}>Type</th>
                  <th className={tableHeadCellRightClass}>Amount</th>
                  <th className={tableHeadCellClass}>Inventory effect</th>
                </tr>
              </thead>
              <tbody>
                {taxRows.map((r) => (
                  <tr key={r.lineKey} className={tableRowClass}>
                    <td className={tableCellClass}>Sales tax<span className="text-xs text-zinc-500"> · {r.description}</span></td>
                    <td className={tableCellRightClass}>{formatMoney(r.lineTotal, currency)}</td>
                    <td className={tableCellMutedClass}>None</td>
                  </tr>
                ))}
                {totals.usedHeaderTax ? (
                  <tr className={tableRowClass}>
                    <td className={tableCellClass}>Tax (from invoice header)</td>
                    <td className={tableCellRightClass}>{formatMoney(header.tax, currency)}</td>
                    <td className={tableCellMutedClass}>None</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {/* ============ TOTALS RECONCILIATION + INVENTORY IMPACT ============ */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Section title="Invoice summary" countLabel={totals.reconciles === null ? undefined : totals.reconciles ? "✓ Reconciles" : `Differs by ${formatMoney(totals.difference, currency)}`}>
          <dl className="flex flex-col gap-1.5 text-sm">
            <TotalsRow label="Merchandise subtotal" value={formatMoney(totals.merchandiseSubtotal, currency)} />
            <TotalsRow label="Expenses & fees" value={formatMoney(totals.expensesAndFees, currency)} />
            <TotalsRow label="Tax" value={formatMoney(totals.tax, currency)} />
            <TotalsRow label="Discounts" value={formatMoney(totals.discounts, currency)} />
            <TotalsRow label="Credits" value={formatMoney(totals.credits, currency)} />
            {totals.unresolved !== 0 ? <TotalsRow label="Unclassified lines" value={formatMoney(totals.unresolved, currency)} warn /> : null}
            <TotalsRow label="Final invoice total" value={formatMoney(totals.headerTotal ?? totals.computedTotal, currency)} emphasize />
          </dl>
        </Section>
        <Section title="Inventory impact">
          {hasInventoryChanges ? (
            <dl className="flex flex-col gap-1.5 text-sm">
              {Object.entries(totalInventoryIncrease).map(([unit, qty]) => (
                <TotalsRow key={unit} label={`Units received (${unit})`} value={`+${Math.round(qty * 100) / 100} ${unit}`} />
              ))}
              {returnRows.length > 0 ? (
                <TotalsRow label="Units returned" value={returnRows.map((r) => `−${r.returnBaseQuantity ?? r.returnQuantity ?? "?"} ${r.inventoryBaseUnitCode ?? r.returnUnitCode ?? ""}`).join(", ")} />
              ) : null}
              <TotalsRow label="Locations" value={soleApproverLocations.length > 0 ? soleApproverLocations.join(", ") : returnRows.map((r) => r.returnLocationName).filter(Boolean).join(", ") || "—"} />
              <TotalsRow label="Price history" value={inventoryRows.length > 0 ? "Recorded for received items" : "No price events"} />
            </dl>
          ) : (
            <>
              <p className="text-2xl font-semibold text-zinc-100">None</p>
              <p className="mt-1 text-sm text-zinc-400">This invoice does not add or remove inventory. Posting records the approved classifications only — no receipt, movement, balance, kiosk unit or price-history event.</p>
            </>
          )}
        </Section>
      </div>

      {/* ============ BLOCKERS -- NEXT TO THE PRIMARY ACTION ============ */}
      {!ready && blockers.length > 0 ? (
        <div className="rounded-lg border border-amber-800 bg-amber-950/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            {blockers.length} thing{blockers.length === 1 ? "" : "s"} remaining
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-200">
            {blockers.map((b, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2">
                <span>• {b.lineKey ? (b.description ?? "A line") : "This document"} — {b.reason}</span>
                {b.lineKey && /classif/i.test(b.reason) ? (
                  <button type="button" onClick={() => onNavigateToStep(1, b.lineKey)} className={`${textLinkClass} text-amber-300`}>
                    Review line
                  </button>
                ) : b.lineKey ? (
                  <button type="button" onClick={() => onNavigateToStep(2, b.lineKey)} className={`${textLinkClass} text-amber-300`}>
                    Open line
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {hasDeliveryConflict ? (
            <div className="mt-3 rounded-lg border border-amber-700 bg-zinc-950/40 p-3">
              <p className="text-sm text-amber-100">Recorded deliveries must be reviewed before this invoice can continue.</p>
              <button type="button" onClick={() => onNavigateToStep(2)} className="mt-2 rounded-md border border-amber-500 bg-amber-500/10 px-4 py-1.5 text-sm font-semibold text-amber-300">
                Review recorded deliveries
              </button>
            </div>
          ) : null}

          {missingDeliveryVerifier && editable ? (
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-700 bg-zinc-950/40 p-3">
              <p className="text-xs text-amber-200/80">Who physically checked this delivery before the invoice was entered?</p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-amber-200">
                  Delivery verified by
                  <select value={verifierChoice} onChange={(e) => setVerifierChoice(e.target.value)} className="rounded-lg border border-amber-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
                    <option value="">Select…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={handleSetDeliveryVerifier} disabled={!verifierChoice || verifierPending} className="rounded-md bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                  {verifierPending ? "Saving…" : "Set"}
                </button>
              </div>
              {verifierError ? <p className="w-full text-xs text-red-400">{verifierError}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ============ ACTIONS ============ */}
      {sendAction.kind === "send" ? (
        <>
          {sendError ? <p className="text-sm text-red-400">{sendError}</p> : null}
          {soleApproverError && !soleApproverModalOpen ? <p className="text-sm text-red-400">{soleApproverError}</p> : null}
          {soleApproverEligible && !amendmentAlreadyPosted ? (
            <WorkflowFooter
              onBack={() => onNavigateToStep(2)}
              backLabel="Back to Items & Receiving"
              contextLabel={!sendAction.enabled ? "Resolve the items above before posting" : hasInventoryChanges ? "Posts the invoice and its inventory changes" : "Records the approved classifications. No inventory changes."}
              contextTone={!sendAction.enabled ? "warning" : "neutral"}
              primaryLabel={primaryLabel}
              onPrimary={() => {
                setSoleApproverError(null);
                setSoleApproverBlockers([]);
                setSoleApproverModalOpen(true);
              }}
              primaryDisabled={!sendAction.enabled}
              primaryPending={soleApproverPending}
              primaryPendingLabel="Posting…"
              primaryTitle={!sendAction.enabled ? "Resolve the items above before posting." : undefined}
              secondaryLabel="Send for Final Review"
              onSecondary={onSend}
              secondaryDisabled={!sendAction.enabled}
              secondaryPending={sendPending}
              secondaryPendingLabel="Sending…"
              sticky={false}
            />
          ) : (
            <WorkflowFooter
              onBack={() => onNavigateToStep(2)}
              backLabel="Back to Items & Receiving"
              contextLabel={!sendAction.enabled ? "Resolve the items above before sending" : amendmentAlreadyPosted ? "Inventory was already posted from the original revision" : undefined}
              contextTone="warning"
              primaryLabel="Send for Final Review"
              onPrimary={onSend}
              primaryDisabled={!sendAction.enabled}
              primaryPending={sendPending}
              primaryPendingLabel="Sending for Final Review…"
              primaryTitle={!sendAction.enabled ? "Resolve the items above before sending for final review." : undefined}
              sticky={false}
            />
          )}
          <p className="text-xs text-zinc-500">
            {soleApproverEligible && !amendmentAlreadyPosted
              ? "Posting now records your name, reason and time in the audit history. Send for Final Review lets another manager independently confirm the invoice first."
              : "Another authorized manager independently confirms the invoice before it is posted."}
          </p>
        </>
      ) : sendAction.kind === "sent" ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/95 px-4 py-3">
          <button type="button" onClick={() => onNavigateToStep(2)} className={textLinkClass}>
            ← Back to Items & Receiving
          </button>
          <div className="flex flex-col items-end gap-0.5">
            <span className="inline-flex cursor-default items-center gap-2 self-end rounded-md border border-emerald-800 bg-emerald-950/30 px-6 py-2 text-sm font-semibold text-emerald-300">✓ Sent for Verification</span>
            <span className="text-xs text-zinc-500">Your review is complete. Another manager can now verify this document.{editable === false ? " Use Withdraw Submission above to make changes." : ""}</span>
          </div>
        </div>
      ) : null}

      {soleApproverModalOpen ? (
        <SoleApproverPostModal
          vendorName={vendorName}
          documentNumber={header.documentNumber}
          invoiceTotal={header.total}
          currency={currency}
          inventoryLineCount={inventoryRows.length}
          expenseLineCount={expenseRows.length}
          creditLineCount={creditRows.length}
          taxLineCount={taxRows.length}
          returnLineCount={returnRows.length}
          hasInventoryChanges={hasInventoryChanges}
          confirmLabel={primaryLabel}
          inventoryValue={inventoryValue}
          locations={soleApproverLocations}
          pending={soleApproverPending}
          error={soleApproverError}
          blockers={soleApproverBlockers}
          onCancel={() => setSoleApproverModalOpen(false)}
          onSendForReview={() => {
            setSoleApproverModalOpen(false);
            onSend();
          }}
          onConfirm={handleConfirmSoleApprover}
        />
      ) : null}
    </div>
  );
}

function SummaryRow({ label, ok, text }: { label: string; ok: boolean | null; text: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={ok === null ? "text-zinc-500" : ok ? "text-emerald-400" : "text-amber-300"}>
        {ok === null ? "" : ok ? "✓ " : "○ "}
        {text}
      </p>
    </div>
  );
}

function Section({ title, countLabel, children }: { title: string; countLabel?: string; children: React.ReactNode }) {
  return (
    <div className={panelClass}>
      <div className={`${panelHeaderClass} flex items-baseline justify-between`}>
        <h2 className={panelTitleClass}>{title}</h2>
        {countLabel ? <span className={panelMetaClass}>{countLabel}</span> : null}
      </div>
      <div className={panelBodyClass}>{children}</div>
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

function TotalsRow({ label, value, emphasize, warn }: { label: string; value: string; emphasize?: boolean; warn?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${emphasize ? "border-t border-zinc-700 pt-2" : ""}`}>
      <dt className={warn ? "text-amber-300" : "text-zinc-500"}>{label}</dt>
      <dd className={`tabular-nums ${emphasize ? "text-base font-semibold text-zinc-100" : warn ? "text-amber-200" : "text-zinc-200"}`}>{value}</dd>
    </div>
  );
}
