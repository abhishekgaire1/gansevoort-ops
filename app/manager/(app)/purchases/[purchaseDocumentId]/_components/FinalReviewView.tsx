"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  verifyPurchaseDocument,
  returnPurchaseDocumentToDraft,
  savePurchaseDocumentReviewCorrections,
  savePurchaseDocumentReviewProposals,
  getPurchaseDocumentPreparationStatus,
  getPurchaseDocumentReviewSummary,
} from "@/app/actions/purchaseDocuments";
import { listInventoryItems, type InventoryItemSummary } from "@/app/actions/itemMaster";
import { getEffectiveReceivingLinesForPurchaseDocument, getReceivingLinesForPurchaseDocument, listLocations, type LocationSummary } from "@/app/actions/receiving";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { MismatchNote, TextField, DateField, NumberField, SelectField } from "./DocumentFields";
import { buildFinalReviewRows, type FinalReviewRow } from "@/app/lib/purchaseDocuments/finalReviewTable";
import { computePurchaseDocumentDiff, purchaseDocumentDiffCount } from "@/app/lib/purchaseDocuments/diff";
import { blockersUnresolvedByProposals, proposalCount, type MappingProposals, type ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";
import { formatMoney } from "@/app/lib/formatMoney";
import { recomputeFixedConversionVerifiedQuantity } from "@/app/lib/receiving/computeReceivingPrefill";
import type { PreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import type { EffectiveReceivingLine } from "@/app/lib/receiving/effectiveReceivingEdit";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";
import type { ReceiptLineConditionStatus } from "@/app/lib/receiving/types";
import type { VendorSummary } from "@/app/actions/vendors";

/**
 * Manager 2's FINAL VERIFICATION -- the second/final pair of eyes, with the
 * original invoice pinned beside one consolidated review table (two
 * independently scrolling panes, like Step 1's split view).
 *
 * AUTHORITY MODEL (the core product rule):
 *
 *   Manager 1 submitted snapshot + Manager 2 proposed corrections
 *     = review working state
 *   ONLY [Final Verify] promotes that state into the VERIFIED
 *   authoritative state.
 *
 * Every reviewer edit here is a PROPOSAL until then, with uniform
 * semantics across all four kinds of correction:
 *
 *  - Document-header and line INVOICE-FACT edits live in this component's
 *    working copy, persisted through save_purchase_document_review_
 *    corrections (on closing an editor) purely so a refresh never loses
 *    them -- the current document rows during READY_FOR_VERIFICATION are
 *    the reviewer working copy, never the authoritative record: the
 *    SUBMITTED audit snapshot preserves Manager 1's state, and Return to
 *    Preparer restores it wholesale.
 *  - ITEM-MAPPING and RECEIVING corrections are stored as an explicit
 *    provisional overlay (purchase_document_review_proposals). Saving a
 *    proposal changes NO authoritative state: the confirmed
 *    classification and the effective receipts remain exactly Manager
 *    1's until promotion. Direct writes through the classification/
 *    receipt RPCs during final review are rejected server-side
 *    (20260811100071) -- even for the legitimate reviewer.
 *  - Final Verify promotes everything atomically server-side: persists
 *    the header/line payload, applies mapping proposals through the
 *    audited approval RPC (against the just-corrected facts -- so an
 *    identity-field edit plus its mapping re-confirmation verifies in
 *    one click), appends receiving proposals as append-only CORRECTION
 *    receipts, re-runs the authoritative completeness gates on the
 *    fully-promoted state, and only then transitions to VERIFIED. Any
 *    failure rolls the entire promotion back.
 *  - Return to Preparer promotes NOTHING: the submitted snapshot is
 *    restored, and pending proposals are preserved only inside the
 *    RETURNED audit event.
 */

const DOCUMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Select type…" },
  { value: "INVOICE", label: "Invoice" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "CREDIT_MEMO", label: "Credit Memo" },
];

const CONDITION_OPTIONS: { value: ReceiptLineConditionStatus; label: string }[] = [
  { value: "RECEIVED_AS_INVOICED", label: "As invoiced" },
  { value: "SHORT", label: "Short" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "NOT_RECEIVED", label: "Not received" },
  { value: "EXCESS", label: "Excess" },
  { value: "OTHER", label: "Other" },
];

function conditionLabel(status: string | null): string | null {
  if (status === null) return null;
  return CONDITION_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

const STATUS_BADGE_CLASS: Record<FinalReviewRow["status"]["kind"], string> = {
  ready: "bg-emerald-400/10 text-emerald-300",
  needs_review: "bg-amber-400/10 text-amber-300",
  exception: "bg-orange-400/10 text-orange-300",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** One editable receiving occurrence (one effective receipt line) inside
 * the row editor -- string-typed like ReceivingPanel's EditLineDraft so
 * typing is never fought. `original` holds the AUTHORITATIVE effective
 * values (never a proposal), so both diff-only proposal building and
 * "was X" markers stay anchored to real state. */
interface ReceivingDraft {
  receiptLineId: string;
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  locationId: string;
  conditionStatus: ReceiptLineConditionStatus;
  original: { receivedQuantity: string; receivedUnit: string; verifiedQuantity: string; locationId: string; conditionStatus: string };
}

/** Drafts prefill from the pending proposal when one exists (so reopening
 * the editor shows what the reviewer already proposed), else from the
 * authoritative effective line. */
function buildReceivingDrafts(effectiveLines: EffectiveReceivingLine[], lineKey: string, proposals: ReceivingProposals): ReceivingDraft[] {
  return effectiveLines
    .filter((line) => line.matchedLineKey === lineKey)
    .map((line) => {
      const proposal = proposals[line.receiptLineId];
      return {
        receiptLineId: line.receiptLineId,
        receivedQuantity: proposal ? String(proposal.receivedQuantity) : line.receivedQuantity !== null ? String(line.receivedQuantity) : "",
        receivedUnit: proposal ? (proposal.receivedUnit ?? "") : (line.receivedUnit ?? ""),
        verifiedQuantity: proposal
          ? proposal.verifiedBaseQuantity !== null
            ? String(proposal.verifiedBaseQuantity)
            : ""
          : line.verifiedBaseQuantity !== null
            ? String(line.verifiedBaseQuantity)
            : "",
        locationId: proposal ? (proposal.locationId ?? "") : (line.locationId ?? ""),
        conditionStatus: (proposal ? proposal.conditionStatus : line.conditionStatus) as ReceiptLineConditionStatus,
        original: {
          receivedQuantity: line.receivedQuantity !== null ? String(line.receivedQuantity) : "",
          receivedUnit: line.receivedUnit ?? "",
          verifiedQuantity: line.verifiedBaseQuantity !== null ? String(line.verifiedBaseQuantity) : "",
          locationId: line.locationId ?? "",
          conditionStatus: line.conditionStatus,
        },
      };
    });
}

export function FinalReviewView(props: {
  purchaseDocumentId: string;
  version: number;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  submittedHeader: PurchaseDocumentHeaderDraft;
  submittedLines: PurchaseDocumentLine[];
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
  vendors: VendorSummary[];
  vendorName: string | null;
  declaredVendorName: string | null;
  aiSuggestedVendorName: string | null;
  declaredDocumentType: PurchaseDocumentType | null;
  aiSuggestedDocumentType: string | null;
  deliveryVerifiedByName: string | null;
  preparerName: string | null;
  initialMappingProposals: MappingProposals;
  initialReceivingProposals: ReceivingProposals;
  initialOverlayVersion: number;
  onReturned: () => void;
  onVerified: () => void;
}) {
  const { purchaseDocumentId, submittedHeader, submittedLines } = props;
  const router = useRouter();

  // Manager 2's working copy of the invoice facts. Initialized from the
  // current server state; diffed against the SUBMITTED snapshot (what
  // verify_purchase_document audits against) for every change marker.
  const [header, setHeader] = useState<PurchaseDocumentHeaderDraft>(props.header);
  const [lines, setLines] = useState<PurchaseDocumentLine[]>(props.lines);
  // What the SERVER currently holds -- advances when the working copy is
  // persisted for refresh recovery. Distinct from the submitted snapshot,
  // which never changes during review.
  const [serverHeader, setServerHeader] = useState<PurchaseDocumentHeaderDraft>(props.header);
  const [serverLines, setServerLines] = useState<PurchaseDocumentLine[]>(props.lines);
  // save_purchase_document_review_corrections bumps the document version;
  // verify/return must always send the CURRENT one.
  const [version, setVersion] = useState(props.version);
  const [editingHeader, setEditingHeader] = useState(false);
  const [expandedLineKey, setExpandedLineKey] = useState<string | null>(null);

  // The provisional correction overlay -- mapping/receiving proposals.
  // Persisted on every change (refresh-safe), authoritative never.
  // overlayVersion is the optimistic-concurrency token (0 = no overlay
  // yet); a stale save is rejected server-side, never merged silently.
  const [mappingProposals, setMappingProposals] = useState<MappingProposals>(props.initialMappingProposals);
  const [receivingProposals, setReceivingProposals] = useState<ReceivingProposals>(props.initialReceivingProposals);
  const [overlayVersion, setOverlayVersion] = useState(props.initialOverlayVersion);
  /** Set when the server reports this tab's review state is stale (another
   * tab advanced it, another reviewer owns it, or the overlay belongs to
   * an earlier submission) -- the only safe way forward is a reload. */
  const [reloadNeeded, setReloadNeeded] = useState<string | null>(null);

  const [summary, setSummary] = useState<PurchaseDocumentReviewSummary | null>(null);
  const [preparationStatus, setPreparationStatus] = useState<PreparationStatus | null>(null);
  const [items, setItems] = useState<InventoryItemSummary[]>([]);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [receivingInfo, setReceivingInfo] = useState<Map<string, ReceivingLineInfo>>(new Map());
  const [effectiveReceiving, setEffectiveReceiving] = useState<EffectiveReceivingLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Row editor state for the expanded line.
  const [receivingDrafts, setReceivingDrafts] = useState<ReceivingDraft[]>([]);
  const [remapItemId, setRemapItemId] = useState("");
  const [rowPending, setRowPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const [verifyPending, setVerifyPending] = useState(false);
  const [returnPending, setReturnPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");

  const refetchReviewData = useCallback(async () => {
    const [statusResult, summaryResult, effectiveResult] = await Promise.all([
      getPurchaseDocumentPreparationStatus(purchaseDocumentId),
      getPurchaseDocumentReviewSummary(purchaseDocumentId),
      getEffectiveReceivingLinesForPurchaseDocument(purchaseDocumentId),
    ]);
    if (statusResult.ok) setPreparationStatus(statusResult.status);
    else setLoadError(statusResult.message);
    if (summaryResult.ok) setSummary(summaryResult.summary);
    else setLoadError(summaryResult.message);
    if (effectiveResult.ok) {
      setEffectiveReceiving(effectiveResult.lines);
      return effectiveResult.lines;
    }
    setLoadError(effectiveResult.message);
    return null;
  }, [purchaseDocumentId]);

  useEffect(() => {
    // Deliberate fetch-on-mount, same pattern as the app's other
    // section-level panels (see InventoryBalancesView).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchReviewData();
    listInventoryItems().then((result) => {
      if (result.ok) setItems(result.items.filter((item) => item.approvalStatus === "CONFIRMED"));
    });
    listLocations().then((result) => {
      if (result.ok) setLocations(result.locations);
    });
    getReceivingLinesForPurchaseDocument(purchaseDocumentId).then((result) => {
      if (result.ok) setReceivingInfo(new Map(result.lines.map((line) => [line.lineKey, line])));
    });
  }, [purchaseDocumentId, refetchReviewData]);

  // ----- change tracking -----------------------------------------------

  const pendingDiff = computePurchaseDocumentDiff(submittedHeader, submittedLines, header, lines);
  const pendingDiffCount = purchaseDocumentDiffCount(pendingDiff);
  const overlayCount = proposalCount(mappingProposals, receivingProposals);
  const correctionCount = pendingDiffCount + overlayCount;

  const changedHeaderFields = new Map(pendingDiff.headerChanges.map((change) => [change.field, change]));
  const changedLineFields = new Map<string, Map<string, { before: unknown; after: unknown }>>();
  for (const change of pendingDiff.lineChanges) {
    if (change.kind === "modified") {
      changedLineFields.set(change.lineKey, new Map(change.fields.map((field) => [field.field, { before: field.before, after: field.after }])));
    }
  }

  // Receiving proposals grouped by the invoice line they belong to.
  const receivingProposalsByLineKey = new Map<string, { receiptLineId: string; proposal: ReceivingProposals[string]; effective: EffectiveReceivingLine }[]>();
  for (const [receiptLineId, proposal] of Object.entries(receivingProposals)) {
    const effective = effectiveReceiving.find((line) => line.receiptLineId === receiptLineId);
    if (!effective) continue;
    if (!receivingProposalsByLineKey.has(effective.matchedLineKey)) receivingProposalsByLineKey.set(effective.matchedLineKey, []);
    receivingProposalsByLineKey.get(effective.matchedLineKey)!.push({ receiptLineId, proposal, effective });
  }

  const blockers = preparationStatus?.blockers ?? [];
  // Preview courtesy only -- Final Verify re-runs the authoritative gates
  // on the promoted state server-side.
  const unresolvedBlockers = blockersUnresolvedByProposals(blockers, new Set(Object.keys(mappingProposals)), new Set(receivingProposalsByLineKey.keys()));
  const provisionallyCoveredCount = blockers.length - unresolvedBlockers.length;
  const canVerify = unresolvedBlockers.length === 0 && summary !== null;

  const rows = buildFinalReviewRows({ lines, summary, blockers });
  const exceptionCount = summary?.exceptions.length ?? 0;
  const inventoryCount = summary?.items.filter((item) => item.disposition === "INVENTORY").length ?? 0;
  const nonInventoryCount = summary?.items.filter((item) => item.disposition === "NON_INVENTORY").length ?? 0;
  const vendorDisplayName = props.vendors.find((vendor) => vendor.id === header.vendorId)?.name ?? props.vendorName;

  function updateHeader<K extends keyof PurchaseDocumentHeaderDraft>(key: K, value: PurchaseDocumentHeaderDraft[K]) {
    setHeader((prev) => ({ ...prev, [key]: value }));
  }

  function updateLine(lineKey: string, patch: Partial<PurchaseDocumentLine>) {
    setLines((prev) => prev.map((line) => (line.lineKey === lineKey ? { ...line, ...patch } : line)));
  }

  // ----- persistence (refresh recovery -- NEVER authority) --------------

  /** Persists the header/line working copy so a refresh can't lose it.
   * The submitted snapshot is untouched; Return restores it regardless. */
  async function persistWorkingCopyIfChanged(): Promise<boolean> {
    const unsaved = purchaseDocumentDiffCount(computePurchaseDocumentDiff(serverHeader, serverLines, header, lines)) > 0;
    if (!unsaved) return true;
    const saved = await savePurchaseDocumentReviewCorrections(purchaseDocumentId, version, header, lines);
    if (!saved.ok) {
      setActionError(saved.message);
      return false;
    }
    setVersion(saved.version);
    setServerHeader({ ...header });
    setServerLines(lines.map((line) => ({ ...line })));
    return true;
  }

  /** Persists the proposal overlay (refresh recovery) under optimistic
   * concurrency. Rolls the local state back if the server rejects it; a
   * conflict/staleness rejection additionally forces a reload -- this tab
   * must never overwrite another tab's (or reviewer's) work. */
  async function persistProposals(nextMapping: MappingProposals, nextReceiving: ReceivingProposals): Promise<boolean> {
    const prevMapping = mappingProposals;
    const prevReceiving = receivingProposals;
    setMappingProposals(nextMapping);
    setReceivingProposals(nextReceiving);
    const result = await savePurchaseDocumentReviewProposals(purchaseDocumentId, overlayVersion, nextMapping, nextReceiving);
    if (!result.ok) {
      setMappingProposals(prevMapping);
      setReceivingProposals(prevReceiving);
      if (result.reason === "review_conflict" || result.reason === "stale_review" || result.reason === "review_owned_elsewhere") {
        setReloadNeeded(result.message);
      } else {
        setRowError(result.message);
      }
      return false;
    }
    setOverlayVersion(result.version);
    return true;
  }

  // ----- row editor -----------------------------------------------------

  async function handleToggleHeaderEditor() {
    if (editingHeader) {
      setEditingHeader(false);
      await persistWorkingCopyIfChanged();
      return;
    }
    setEditingHeader(true);
  }

  async function toggleRowEditor(lineKey: string) {
    setRowError(null);
    if (expandedLineKey === lineKey) {
      setExpandedLineKey(null);
      await persistWorkingCopyIfChanged();
      return;
    }
    setExpandedLineKey(lineKey);
    setRemapItemId(mappingProposals[lineKey]?.inventoryItemId ?? "");
    setReceivingDrafts(buildReceivingDrafts(effectiveReceiving, lineKey, receivingProposals));
  }

  function updateReceivingDraft(receiptLineId: string, patch: Partial<Omit<ReceivingDraft, "receiptLineId" | "original">>) {
    const info = expandedLineKey ? (receivingInfo.get(expandedLineKey) ?? null) : null;
    setReceivingDrafts((prev) =>
      prev.map((draft) => {
        if (draft.receiptLineId !== receiptLineId) return draft;
        const next = { ...draft, ...patch };
        // Same FIXED_CONVERSION consistency rule as Step 3's receiving
        // form: a corrected received qty/unit immediately re-derives the
        // base quantity (promotion re-validates server-side, GA015).
        if (info?.receivingBehavior === "FIXED_CONVERSION" && (patch.receivedQuantity !== undefined || patch.receivedUnit !== undefined)) {
          next.verifiedQuantity = recomputeFixedConversionVerifiedQuantity(info, next.receivedQuantity, next.receivedUnit);
        }
        return next;
      })
    );
  }

  async function handleSaveReceivingProposal() {
    if (rowPending || !expandedLineKey) return;
    const nextReceiving: ReceivingProposals = { ...receivingProposals };
    let anyChange = false;
    let invalid = false;
    for (const draft of receivingDrafts) {
      const differsFromEffective =
        draft.receivedQuantity !== draft.original.receivedQuantity ||
        draft.receivedUnit !== draft.original.receivedUnit ||
        draft.verifiedQuantity !== draft.original.verifiedQuantity ||
        draft.locationId !== draft.original.locationId ||
        draft.conditionStatus !== draft.original.conditionStatus;
      if (!differsFromEffective) {
        // Back to the authoritative values -- clear any prior proposal.
        if (nextReceiving[draft.receiptLineId]) {
          delete nextReceiving[draft.receiptLineId];
          anyChange = true;
        }
        continue;
      }
      const quantity = Number(draft.receivedQuantity);
      if (draft.receivedQuantity.trim() === "" || !Number.isFinite(quantity) || quantity < 0) {
        invalid = true;
        continue;
      }
      nextReceiving[draft.receiptLineId] = {
        receivedQuantity: quantity,
        receivedUnit: draft.receivedUnit || null,
        verifiedBaseQuantity: draft.verifiedQuantity.trim() !== "" ? Number(draft.verifiedQuantity) : null,
        locationId: draft.locationId || null,
        conditionStatus: draft.conditionStatus,
      };
      anyChange = true;
    }
    if (invalid) {
      setRowError("Each proposed line needs a valid received quantity.");
      return;
    }
    if (!anyChange) {
      setRowError("No receiving changes to propose.");
      return;
    }
    setRowPending(true);
    setRowError(null);
    await persistProposals(mappingProposals, nextReceiving);
    setRowPending(false);
  }

  async function handleApplyRemap() {
    if (rowPending || !expandedLineKey) return;
    const nextMapping: MappingProposals = { ...mappingProposals };
    if (remapItemId === "") {
      if (!nextMapping[expandedLineKey]) return;
      delete nextMapping[expandedLineKey];
    } else {
      nextMapping[expandedLineKey] = { inventoryItemId: remapItemId };
    }
    setRowPending(true);
    setRowError(null);
    await persistProposals(nextMapping, receivingProposals);
    setRowPending(false);
  }

  // ----- actions --------------------------------------------------------

  async function handleVerify() {
    if (verifyPending || returnPending) return;
    setVerifyPending(true);
    setActionError(null);
    setActionNotice(null);

    // One atomic promotion: the header/line payload rides verify's own
    // save path, the persisted proposal overlay is promoted inside the
    // same transaction, and the authoritative gates run on the resulting
    // state -- so identity-field edits + their mapping re-confirmation
    // land in one click, and any failure changes nothing at all.
    const result =
      pendingDiffCount > 0
        ? await verifyPurchaseDocument(purchaseDocumentId, version, header, lines)
        : await verifyPurchaseDocument(purchaseDocumentId, version);
    setVerifyPending(false);
    if (!result.ok) {
      if (result.reason === "stale_review") {
        // The overlay belongs to an earlier submission (or a target is no
        // longer current) -- nothing was promoted or consumed; the only
        // safe way forward is reloading the current submission.
        setReloadNeeded(result.message);
        return;
      }
      setActionError(result.message);
      if (result.reason === "preparation_incomplete") {
        setActionNotice(
          "A pending correction leaves this document incomplete. If you changed an item-identifying field (SKU, description, or unit), propose the correct item mapping for that line via Edit → Item Resolution, then Final Verify again."
        );
      }
      // The authoritative gates may have caught something this page's
      // preview state hadn't refreshed yet -- pull the latest blockers.
      refetchReviewData();
      return;
    }
    props.onVerified();
  }

  async function handleReturn() {
    if (verifyPending || returnPending) return;
    setReturnPending(true);
    setActionError(null);
    setActionNotice(null);
    const result = await returnPurchaseDocumentToDraft(purchaseDocumentId, version, returnReason.trim() || undefined);
    setReturnPending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    props.onReturned();
  }

  // ----- render ---------------------------------------------------------

  const typeLabel = header.documentType === "RECEIPT" ? "Receipt #" : header.documentType === "CREDIT_MEMO" ? "Credit Memo #" : "Invoice #";
  const itemNameById = new Map(items.map((item) => [item.id, item.name]));

  return (
    <div className="mt-4 lg:grid lg:grid-cols-5 lg:items-start lg:gap-4">
      {/* ---------------- LEFT: original document, sticky ---------------- */}
      <div className="mb-4 lg:sticky lg:top-4 lg:col-span-2 lg:mb-0">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Original Document</h2>
          <div className="lg:h-[calc(100vh-8.5rem)] lg:overflow-auto">
            <DocumentViewer viewUrl={props.viewUrl} viewError={props.viewError} contentType={props.contentType} heightClassName="h-[70vh] lg:h-full" />
          </div>
        </div>
      </div>

      {/* ---------------- RIGHT: final review ---------------- */}
      <div className="flex flex-col gap-4 lg:col-span-3">
        {reloadNeeded ? (
          <div className="rounded-2xl border border-amber-700 bg-amber-950/40 p-4">
            <p className="text-sm font-semibold text-amber-200">{reloadNeeded}</p>
            <button
              type="button"
              onClick={() => {
                setReloadNeeded(null);
                router.refresh();
              }}
              className="mt-2 rounded-full border border-amber-600 px-4 py-1.5 text-xs font-semibold text-amber-300"
            >
              Reload Review
            </button>
          </div>
        ) : null}
        {/* Compact document header */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Final Review</h2>
            <div className="flex items-center gap-3">
              {correctionCount > 0 ? (
                <span className="rounded-full bg-amber-400/15 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
                  {correctionCount} correction{correctionCount === 1 ? "" : "s"} made
                </span>
              ) : null}
              <button type="button" onClick={handleToggleHeaderEditor} className="text-xs text-amber-400 underline underline-offset-2">
                {editingHeader ? "Done Editing" : "Edit Document Fields"}
              </button>
            </div>
          </div>

          <div className="mt-2">
            <MismatchNote label="Vendor" declared={props.declaredVendorName} aiSuggested={props.aiSuggestedVendorName} current={vendorDisplayName} />
            <MismatchNote label="Document type" declared={props.declaredDocumentType} aiSuggested={props.aiSuggestedDocumentType} current={header.documentType} />
          </div>

          {!editingHeader ? (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <ReadOnlyField label="Vendor" value={vendorDisplayName} changed={changedHeaderFields.has("vendorId")} />
              <ReadOnlyField
                label={typeLabel}
                value={header.documentNumber}
                changed={changedHeaderFields.has("documentNumber")}
                submitted={display(changedHeaderFields.get("documentNumber")?.before)}
              />
              <ReadOnlyField
                label="Invoice Date"
                value={formatDate(header.documentDate)}
                changed={changedHeaderFields.has("documentDate")}
                submitted={formatDate((changedHeaderFields.get("documentDate")?.before as string | null) ?? null)}
              />
              <ReadOnlyField
                label="Delivery Date"
                value={formatDate(header.deliveryDate)}
                changed={changedHeaderFields.has("deliveryDate")}
                submitted={formatDate((changedHeaderFields.get("deliveryDate")?.before as string | null) ?? null)}
              />
              <ReadOnlyField label="PO #" value={header.poNumber} changed={changedHeaderFields.has("poNumber")} submitted={display(changedHeaderFields.get("poNumber")?.before)} />
              <ReadOnlyField label="Prepared by" value={props.preparerName} />
              <ReadOnlyField label="Delivery verified by" value={props.deliveryVerifiedByName} missingIsProblem />
              <ReadOnlyField
                label="Total"
                value={formatMoney(header.total, header.currency)}
                changed={changedHeaderFields.has("total")}
                submitted={formatMoney((changedHeaderFields.get("total")?.before as number | null) ?? null, header.currency)}
                emphasize
              />
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <SelectField
                label="Vendor"
                value={header.vendorId ?? ""}
                disabled={false}
                changed={changedHeaderFields.has("vendorId")}
                onChange={(value) => updateHeader("vendorId", value === "" ? null : value)}
                options={[{ value: "", label: "Select vendor…" }, ...props.vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))]}
              />
              <SelectField
                label="Document Type"
                value={header.documentType ?? ""}
                disabled={false}
                changed={changedHeaderFields.has("documentType")}
                submitted={display(changedHeaderFields.get("documentType")?.before)}
                onChange={(value) => updateHeader("documentType", value === "" ? null : (value as PurchaseDocumentType))}
                options={DOCUMENT_TYPE_OPTIONS}
              />
              <TextField
                label={typeLabel}
                value={header.documentNumber}
                disabled={false}
                changed={changedHeaderFields.has("documentNumber")}
                submitted={display(changedHeaderFields.get("documentNumber")?.before)}
                onChange={(value) => updateHeader("documentNumber", value)}
              />
              <DateField
                label="Invoice Date"
                value={header.documentDate}
                disabled={false}
                changed={changedHeaderFields.has("documentDate")}
                submitted={display(changedHeaderFields.get("documentDate")?.before)}
                onChange={(value) => updateHeader("documentDate", value)}
              />
              <DateField
                label="Delivery Date"
                value={header.deliveryDate}
                disabled={false}
                changed={changedHeaderFields.has("deliveryDate")}
                submitted={display(changedHeaderFields.get("deliveryDate")?.before)}
                onChange={(value) => updateHeader("deliveryDate", value)}
              />
              <TextField
                label="PO #"
                value={header.poNumber}
                disabled={false}
                changed={changedHeaderFields.has("poNumber")}
                submitted={display(changedHeaderFields.get("poNumber")?.before)}
                onChange={(value) => updateHeader("poNumber", value)}
              />
              <NumberField
                label="Subtotal"
                value={header.subtotal}
                disabled={false}
                changed={changedHeaderFields.has("subtotal")}
                submitted={display(changedHeaderFields.get("subtotal")?.before)}
                onChange={(value) => updateHeader("subtotal", value)}
              />
              <NumberField
                label="Tax"
                value={header.tax}
                disabled={false}
                changed={changedHeaderFields.has("tax")}
                submitted={display(changedHeaderFields.get("tax")?.before)}
                onChange={(value) => updateHeader("tax", value)}
              />
              <NumberField
                label="Fees"
                value={header.fees}
                disabled={false}
                changed={changedHeaderFields.has("fees")}
                submitted={display(changedHeaderFields.get("fees")?.before)}
                onChange={(value) => updateHeader("fees", value)}
              />
              <NumberField
                label="Total"
                value={header.total}
                disabled={false}
                changed={changedHeaderFields.has("total")}
                submitted={display(changedHeaderFields.get("total")?.before)}
                onChange={(value) => updateHeader("total", value)}
              />
            </div>
          )}

          <p className="mt-3 text-xs text-zinc-500">
            {summary === null ? (
              "Loading review data…"
            ) : (
              <>
                {summary.itemsTotalCount} lines · {inventoryCount} inventory · {nonInventoryCount} non-inventory ·{" "}
                {exceptionCount === 0 ? (
                  "No exceptions"
                ) : (
                  <span className="font-semibold text-amber-300">
                    {exceptionCount} exception{exceptionCount === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}
          </p>
        </section>

        {/* Consolidated line review table */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Line Review</h2>
          {loadError ? <p className="mb-2 text-sm text-red-400">{loadError}</p> : null}
          {summary === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <div className="max-h-[36rem] overflow-auto rounded-lg border border-zinc-800">
              <table className="w-full min-w-[1150px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-zinc-950 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-2.5 py-2 font-normal">Type</th>
                    <th className="px-2.5 py-2 font-normal">SKU</th>
                    <th className="px-2.5 py-2 font-normal">Vendor Item</th>
                    <th className="px-2.5 py-2 font-normal">Mapped Item</th>
                    <th className="px-2.5 py-2 text-right font-normal">Qty</th>
                    <th className="px-2.5 py-2 font-normal">Unit</th>
                    <th className="px-2.5 py-2 text-right font-normal">Unit Price</th>
                    <th className="px-2.5 py-2 text-right font-normal">Line Total</th>
                    <th className="px-2.5 py-2 font-normal">Received</th>
                    <th className="px-2.5 py-2 font-normal">Inventory Qty</th>
                    <th className="px-2.5 py-2 font-normal">Location</th>
                    <th className="px-2.5 py-2 font-normal">Condition</th>
                    <th className="px-2.5 py-2 font-normal">Status</th>
                    <th className="px-2.5 py-2 font-normal" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {rows.map((row, index) => {
                    const lineKey = row.lineKey;
                    const changed = lineKey ? changedLineFields.get(lineKey) : undefined;
                    const line = lineKey ? (lines.find((candidate) => candidate.lineKey === lineKey) ?? null) : null;
                    const expanded = lineKey !== null && expandedLineKey === lineKey;
                    const rowTint = row.status.kind === "exception" ? "bg-orange-950/20" : row.status.kind === "needs_review" ? "bg-amber-950/10" : "";

                    const mappingProposal = lineKey ? mappingProposals[lineKey] : undefined;
                    const proposedItemName = mappingProposal ? (itemNameById.get(mappingProposal.inventoryItemId) ?? "…") : null;
                    const lineReceivingProposals = lineKey ? (receivingProposalsByLineKey.get(lineKey) ?? []) : [];
                    const baseUnitCode = lineKey ? (receivingInfo.get(lineKey)?.baseUnitCode ?? null) : null;

                    const proposedReceivedLabel =
                      lineReceivingProposals.length > 0
                        ? lineReceivingProposals
                            .map(({ proposal }) => `${proposal.receivedQuantity}${proposal.receivedUnit ? ` ${proposal.receivedUnit}` : ""}`)
                            .join(" · ")
                        : null;
                    const proposedInventoryQtyLabel =
                      lineReceivingProposals.length > 0 && lineReceivingProposals.some(({ proposal }) => proposal.verifiedBaseQuantity !== null)
                        ? lineReceivingProposals
                            .filter(({ proposal }) => proposal.verifiedBaseQuantity !== null)
                            .map(({ proposal }) => `${proposal.verifiedBaseQuantity}${baseUnitCode ? ` ${baseUnitCode}` : ""}`)
                            .join(" · ")
                        : null;
                    const proposedLocationLabel =
                      lineReceivingProposals.length > 0
                        ? (locations.find((location) => location.id === lineReceivingProposals[0].proposal.locationId)?.name ?? null)
                        : null;
                    const proposedConditionLabel = lineReceivingProposals.length > 0 ? conditionLabel(lineReceivingProposals[0].proposal.conditionStatus) : null;

                    return (
                      <ReviewRowGroup key={lineKey ?? `row-${index}`}>
                        <tr className={`${rowTint} align-top`}>
                          <td className="px-2.5 py-2 text-zinc-400">{row.typeLabel}</td>
                          <td className="px-2.5 py-2 text-zinc-400">
                            <ChangedCell value={display(row.sku)} change={changed?.get("vendorSku")} />
                          </td>
                          <td className="max-w-52 px-2.5 py-2 text-zinc-200">
                            <ChangedCell value={display(row.description)} change={changed?.get("description")} />
                          </td>
                          <td className="max-w-52 px-2.5 py-2">
                            {mappingProposal ? (
                              <>
                                <p className="font-semibold text-amber-300">{proposedItemName}</p>
                                <p className="text-[10px] text-zinc-500">Changed from {display(row.matchedLabel)} · pending Final Verify</p>
                              </>
                            ) : (
                              <>
                                <p className="text-zinc-200">{display(row.matchedLabel)}</p>
                                {row.secondary ? <p className="mt-0.5 text-xs text-zinc-500">{row.secondary}</p> : null}
                              </>
                            )}
                            {lineReceivingProposals.length > 0 ? <p className="mt-0.5 text-[11px] font-semibold text-amber-300">✎ pending receiving correction</p> : null}
                          </td>
                          <td className="px-2.5 py-2 text-right text-zinc-200">
                            <ChangedCell value={display(row.quantity)} change={changed?.get("packageQuantity") ?? changed?.get("measuredQuantity")} alignRight />
                          </td>
                          <td className="px-2.5 py-2 text-zinc-400">
                            <ChangedCell value={display(row.unit)} change={changed?.get("packageUnit") ?? changed?.get("measuredUnit")} />
                          </td>
                          <td className="px-2.5 py-2 text-right text-zinc-200">
                            <ChangedCell
                              value={row.unitPrice !== null ? formatMoney(row.unitPrice, header.currency) : "—"}
                              change={changed?.get("unitPrice")}
                              alignRight
                              formatBefore={(before) => formatMoney(typeof before === "number" ? before : null, header.currency)}
                            />
                          </td>
                          <td className="px-2.5 py-2 text-right text-zinc-200">
                            <ChangedCell
                              value={row.lineTotal !== null ? formatMoney(row.lineTotal, header.currency) : "—"}
                              change={changed?.get("lineTotal")}
                              alignRight
                              formatBefore={(before) => formatMoney(typeof before === "number" ? before : null, header.currency)}
                            />
                          </td>
                          <td className="px-2.5 py-2 text-zinc-200">
                            <ProposedCell proposed={proposedReceivedLabel} authoritative={display(row.receivedLabel)} />
                          </td>
                          <td className="px-2.5 py-2 text-zinc-200">
                            <ProposedCell proposed={proposedInventoryQtyLabel} authoritative={display(row.inventoryQuantityLabel)} />
                          </td>
                          <td className="px-2.5 py-2 text-zinc-400">
                            <ProposedCell proposed={proposedLocationLabel} authoritative={display(row.locationName)} />
                          </td>
                          <td className="px-2.5 py-2 text-zinc-400">
                            <ProposedCell proposed={proposedConditionLabel} authoritative={display(row.conditionLabel)} />
                          </td>
                          <td className="px-2.5 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE_CLASS[row.status.kind]}`} title={row.problems.join("\n") || undefined}>
                              {row.status.label}
                            </span>
                          </td>
                          <td className="px-2.5 py-2">
                            {lineKey !== null ? (
                              <button type="button" onClick={() => toggleRowEditor(lineKey)} className="text-xs text-amber-400 underline underline-offset-2">
                                {expanded ? "Close" : "Edit"}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                        {row.problems.length > 0 ? (
                          <tr className={rowTint}>
                            <td colSpan={14} className="px-2.5 pb-2 pt-0">
                              <ul className="flex flex-col gap-0.5 text-xs text-amber-300">
                                {row.problems.map((problem, problemIndex) => (
                                  <li key={problemIndex}>⚠ {problem}</li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ) : null}
                        {expanded && line !== null ? (
                          <tr className="bg-zinc-950/60">
                            <td colSpan={14} className="px-3 py-3">
                              <LineEditor
                                line={line}
                                changed={changed}
                                onLineChange={(patch) => updateLine(lineKey, patch)}
                                items={items}
                                currentMappedLabel={row.matchedLabel}
                                hasMappingProposal={!!mappingProposal}
                                remapItemId={remapItemId}
                                onRemapItemIdChange={setRemapItemId}
                                onApplyRemap={handleApplyRemap}
                                receivingDrafts={receivingDrafts}
                                receivingInfo={receivingInfo.get(lineKey) ?? null}
                                locations={locations}
                                onReceivingDraftChange={updateReceivingDraft}
                                onSaveReceiving={handleSaveReceivingProposal}
                                pending={rowPending}
                                error={rowError}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </ReviewRowGroup>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals footer */}
          <div className="mt-3 flex flex-col items-end gap-0.5 text-sm">
            <TotalRow label="Subtotal" value={formatMoney(header.subtotal, header.currency)} changed={changedHeaderFields.has("subtotal")} />
            <TotalRow label="Tax" value={formatMoney(header.tax, header.currency)} changed={changedHeaderFields.has("tax")} />
            <TotalRow label="Fees" value={formatMoney(header.fees, header.currency)} changed={changedHeaderFields.has("fees")} />
            <TotalRow label="TOTAL" value={formatMoney(header.total, header.currency)} changed={changedHeaderFields.has("total")} emphasize />
          </div>
        </section>

        {/* Review summary + actions */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Review Summary</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            <SummaryLine
              ok={summary !== null ? summary.itemsConfirmedCount === summary.itemsTotalCount : null}
              label={summary !== null ? `${summary.itemsConfirmedCount} / ${summary.itemsTotalCount} items resolved` : "Loading…"}
            />
            <SummaryLine
              ok={summary !== null ? summary.receivingCompleteCount === summary.receivingTotalCount : null}
              label={summary !== null ? `${summary.receivingCompleteCount} / ${summary.receivingTotalCount} inventory lines received` : "Loading…"}
            />
            <SummaryLine
              ok={props.deliveryVerifiedByName !== null}
              label={props.deliveryVerifiedByName !== null ? `Delivery verified by ${props.deliveryVerifiedByName}` : "No delivery verifier recorded"}
            />
            <SummaryLine
              ok={exceptionCount === 0}
              warnOnly
              label={exceptionCount === 0 ? "No exceptions" : `${exceptionCount} documented exception${exceptionCount === 1 ? "" : "s"}`}
            />
            {correctionCount > 0 ? (
              <SummaryLine ok amber label={`${correctionCount} pending correction${correctionCount === 1 ? "" : "s"} -- applied only at Final Verify`} />
            ) : null}
          </ul>

          {unresolvedBlockers.length > 0 ? (
            <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/20 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Cannot verify yet</p>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-amber-200">
                {unresolvedBlockers.map((blocker, blockerIndex) => (
                  <li key={blockerIndex}>
                    • {blocker.lineKey !== null ? `${blocker.description ?? "A line"} — ` : ""}
                    {blocker.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {provisionallyCoveredCount > 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              {provisionallyCoveredCount} blocker{provisionallyCoveredCount === 1 ? " is" : "s are"} provisionally addressed by pending corrections -- Final Verify
              validates them authoritatively.
            </p>
          ) : null}

          {actionError ? <p className="mt-3 text-sm text-red-400">{actionError}</p> : null}
          {actionNotice ? <p className="mt-3 rounded-lg border border-amber-800 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">{actionNotice}</p> : null}

          <div className="mt-4 flex flex-col gap-3">
            <input
              type="text"
              value={returnReason}
              onChange={(event) => setReturnReason(event.target.value)}
              placeholder="Reason for returning (optional)"
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleReturn}
                disabled={verifyPending || returnPending || reloadNeeded !== null}
                className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
              >
                {returnPending ? "Returning…" : "Return to Preparer"}
              </button>
              <button
                type="button"
                onClick={handleVerify}
                disabled={verifyPending || returnPending || !canVerify || reloadNeeded !== null}
                title={!canVerify ? "Resolve the blockers listed above first." : undefined}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {verifyPending
                  ? "Finalizing…"
                  : correctionCount > 0
                    ? `Final Verify with ${correctionCount} Change${correctionCount === 1 ? "" : "s"}`
                    : "Final Verify"}
              </button>
            </div>
            {correctionCount > 0 ? (
              <p className="text-xs text-zinc-500">
                Nothing above is final yet: Final Verify applies all pending corrections atomically. Returning to the preparer instead restores their submitted
                version and applies none of them (they stay in the audit history).
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Fragment wrapper so each logical row group (main row + problems row +
 * editor row) can take a single key. */
function ReviewRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ReadOnlyField({
  label,
  value,
  changed,
  submitted,
  emphasize,
  missingIsProblem,
}: {
  label: string;
  value: string | null;
  changed?: boolean;
  submitted?: string;
  emphasize?: boolean;
  missingIsProblem?: boolean;
}) {
  const missing = value === null || value === "—";
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={emphasize ? "text-base font-semibold text-zinc-100" : missingIsProblem && missing ? "text-sm font-semibold text-amber-300" : "text-sm text-zinc-200"}>
        {value ?? "—"}
        {changed ? <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Changed</span> : null}
      </p>
      {changed && submitted !== undefined ? <p className="text-[10px] text-zinc-500">Submitted: {submitted}</p> : null}
    </div>
  );
}

function ChangedCell({
  value,
  change,
  alignRight,
  formatBefore,
}: {
  value: string;
  change: { before: unknown; after: unknown } | undefined;
  alignRight?: boolean;
  formatBefore?: (before: unknown) => string;
}) {
  if (!change) return <>{value}</>;
  const before = formatBefore ? formatBefore(change.before) : display(change.before);
  return (
    <span className={`flex flex-col ${alignRight ? "items-end" : "items-start"}`}>
      <span className="font-semibold text-amber-300">{value}</span>
      <span className="text-[10px] text-zinc-500">was {before}</span>
    </span>
  );
}

/** A cell whose value may be overridden by a PENDING receiving proposal --
 * shows the proposed value with the authoritative one beneath, so it is
 * always visible that the effective receipt still says otherwise. */
function ProposedCell({ proposed, authoritative }: { proposed: string | null; authoritative: string }) {
  if (proposed === null) return <>{authoritative}</>;
  return (
    <span className="flex flex-col items-start">
      <span className="font-semibold text-amber-300">{proposed}</span>
      <span className="text-[10px] text-zinc-500">now {authoritative}</span>
    </span>
  );
}

function TotalRow({ label, value, changed, emphasize }: { label: string; value: string; changed: boolean; emphasize?: boolean }) {
  return (
    <p className={emphasize ? "font-semibold text-zinc-100" : "text-zinc-400"}>
      {label}
      <span className={`ml-4 inline-block w-28 text-right ${changed ? "font-semibold text-amber-300" : emphasize ? "" : "text-zinc-200"}`}>{value}</span>
      {changed ? <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Changed</span> : null}
    </p>
  );
}

function SummaryLine({ ok, label, amber, warnOnly }: { ok: boolean | null; label: string; amber?: boolean; warnOnly?: boolean }) {
  const color = amber ? "text-amber-300" : ok === null ? "text-zinc-500" : ok ? "text-emerald-400" : "text-amber-300";
  return (
    <li className={color}>
      {ok === null ? "…" : ok ? "✓" : warnOnly ? "⚠" : "○"} {label}
    </li>
  );
}

/** The expanded per-row correction editor. All three sections produce
 * PROPOSALS: invoice facts in the working copy (persisted for refresh
 * recovery), item resolution and receiving in the provisional overlay --
 * nothing is applied until Final Verify. */
function LineEditor({
  line,
  changed,
  onLineChange,
  items,
  currentMappedLabel,
  hasMappingProposal,
  remapItemId,
  onRemapItemIdChange,
  onApplyRemap,
  receivingDrafts,
  receivingInfo,
  locations,
  onReceivingDraftChange,
  onSaveReceiving,
  pending,
  error,
}: {
  line: PurchaseDocumentLine;
  changed: Map<string, { before: unknown; after: unknown }> | undefined;
  onLineChange: (patch: Partial<PurchaseDocumentLine>) => void;
  items: InventoryItemSummary[];
  currentMappedLabel: string | null;
  hasMappingProposal: boolean;
  remapItemId: string;
  onRemapItemIdChange: (value: string) => void;
  onApplyRemap: () => void;
  receivingDrafts: ReceivingDraft[];
  receivingInfo: ReceivingLineInfo | null;
  locations: LocationSummary[];
  onReceivingDraftChange: (receiptLineId: string, patch: Partial<Omit<ReceivingDraft, "receiptLineId" | "original">>) => void;
  onSaveReceiving: () => void;
  pending: boolean;
  error: string | null;
}) {
  const unitCandidates = receivingInfo
    ? Array.from(new Set([receivingInfo.baseUnitCode, receivingInfo.purchaseUnitCode].filter((unit): unit is string => unit !== null)))
    : [];
  return (
    <div className="flex flex-col gap-4">
      {/* Invoice facts -- working-copy proposal, applied at Final Verify */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Invoice Facts <span className="ml-1 font-normal normal-case text-zinc-600">(pending -- applied at Final Verify)</span>
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-600">
          SKU, description, and units identify the item -- correcting one usually also needs the right item mapping proposed below.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <TextField
            label="SKU"
            value={line.vendorSku}
            disabled={false}
            changed={changed?.has("vendorSku")}
            submitted={display(changed?.get("vendorSku")?.before)}
            onChange={(value) => onLineChange({ vendorSku: value })}
          />
          <TextField
            label="Description"
            value={line.description}
            disabled={false}
            changed={changed?.has("description")}
            submitted={display(changed?.get("description")?.before)}
            onChange={(value) => onLineChange({ description: value })}
          />
          <NumberField
            label="Package Qty"
            value={line.packageQuantity}
            disabled={false}
            changed={changed?.has("packageQuantity")}
            submitted={display(changed?.get("packageQuantity")?.before)}
            onChange={(value) => onLineChange({ packageQuantity: value })}
          />
          <TextField
            label="Package Unit"
            value={line.packageUnit}
            disabled={false}
            changed={changed?.has("packageUnit")}
            submitted={display(changed?.get("packageUnit")?.before)}
            onChange={(value) => onLineChange({ packageUnit: value })}
          />
          <NumberField
            label="Measured Qty"
            value={line.measuredQuantity}
            disabled={false}
            changed={changed?.has("measuredQuantity")}
            submitted={display(changed?.get("measuredQuantity")?.before)}
            onChange={(value) => onLineChange({ measuredQuantity: value })}
          />
          <TextField
            label="Measured Unit"
            value={line.measuredUnit}
            disabled={false}
            changed={changed?.has("measuredUnit")}
            submitted={display(changed?.get("measuredUnit")?.before)}
            onChange={(value) => onLineChange({ measuredUnit: value })}
          />
          <NumberField
            label="Unit Price"
            value={line.unitPrice}
            disabled={false}
            changed={changed?.has("unitPrice")}
            submitted={display(changed?.get("unitPrice")?.before)}
            onChange={(value) => onLineChange({ unitPrice: value })}
          />
          <TextField
            label="Price Basis Unit"
            value={line.priceBasisUnit}
            disabled={false}
            changed={changed?.has("priceBasisUnit")}
            submitted={display(changed?.get("priceBasisUnit")?.before)}
            onChange={(value) => onLineChange({ priceBasisUnit: value })}
          />
          <NumberField
            label="Line Total"
            value={line.lineTotal}
            disabled={false}
            changed={changed?.has("lineTotal")}
            submitted={display(changed?.get("lineTotal")?.before)}
            onChange={(value) => onLineChange({ lineTotal: value })}
          />
        </div>
      </div>

      {/* Item resolution -- overlay proposal, promoted at Final Verify */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Item Resolution{" "}
          <span className="ml-1 font-normal normal-case text-zinc-600">(pending -- applied at Final Verify · currently: {currentMappedLabel ?? "unresolved"})</span>
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Propose a different confirmed item
            <select
              value={remapItemId}
              onChange={(event) => onRemapItemIdChange(event.target.value)}
              className="min-w-64 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="">Keep current mapping</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.baseUnitCode ? ` (${item.baseUnitCode})` : ""}
                  {item.disposition === "NON_INVENTORY" ? " — non-inventory" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={onApplyRemap}
            disabled={pending || (remapItemId === "" && !hasMappingProposal)}
            className="rounded-full border border-amber-700 px-4 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-40"
          >
            {pending ? "Saving…" : remapItemId === "" && hasMappingProposal ? "Withdraw Proposal" : "Propose Mapping"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">
          Item configuration itself (category, base unit, receiving behavior, conversion) is corrected in the Item Master, not from this review.
        </p>
      </div>

      {/* Receiving -- overlay proposal, promoted at Final Verify */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Receiving <span className="ml-1 font-normal normal-case text-zinc-600">(pending -- the effective receipt is only corrected at Final Verify)</span>
        </p>
        {receivingDrafts.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-500">No recorded receipt for this line -- nothing to correct here.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            {receivingDrafts.map((draft) => (
              <div key={draft.receiptLineId} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Received Qty
                  <input
                    type="number"
                    value={draft.receivedQuantity}
                    onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { receivedQuantity: event.target.value })}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Unit
                  {unitCandidates.length > 0 ? (
                    <select
                      value={draft.receivedUnit}
                      onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { receivedUnit: event.target.value })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                    >
                      {draft.receivedUnit !== "" && !unitCandidates.includes(draft.receivedUnit) ? <option value={draft.receivedUnit}>{draft.receivedUnit}</option> : null}
                      {unitCandidates.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={draft.receivedUnit}
                      onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { receivedUnit: event.target.value })}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                    />
                  )}
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  {receivingInfo?.baseUnitCode ? `Inventory Qty (${receivingInfo.baseUnitCode})` : "Inventory Qty"}
                  <input
                    type="number"
                    value={draft.verifiedQuantity}
                    disabled={receivingInfo?.receivingBehavior === "FIXED_CONVERSION"}
                    title={
                      receivingInfo?.receivingBehavior === "FIXED_CONVERSION"
                        ? "Derived from the received quantity by the item's confirmed conversion."
                        : undefined
                    }
                    onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { verifiedQuantity: event.target.value })}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Location
                  <select
                    value={draft.locationId}
                    onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { locationId: event.target.value })}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                  >
                    <option value="">Select location…</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Condition
                  <select
                    value={draft.conditionStatus}
                    onChange={(event) => onReceivingDraftChange(draft.receiptLineId, { conditionStatus: event.target.value as ReceiptLineConditionStatus })}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
                  >
                    {CONDITION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
            <button
              type="button"
              onClick={onSaveReceiving}
              disabled={pending}
              className="self-start rounded-full border border-amber-700 px-4 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-40"
            >
              {pending ? "Saving proposal…" : "Propose Receiving Correction"}
            </button>
          </div>
        )}
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
