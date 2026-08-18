import { notFound } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listVendors } from "@/app/actions/vendors";
import { findPossibleDuplicatePurchaseDocuments } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { PurchaseDocumentReviewView } from "./_components/PurchaseDocumentReviewView";
import { VerifiedPurchaseDocumentSummary } from "./_components/VerifiedPurchaseDocumentSummary";
import { DiscardedPurchaseDocumentSummary } from "./_components/DiscardedPurchaseDocumentSummary";
import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { RevisionSummary } from "@/app/lib/purchaseDocuments/types";
import type { MappingProposals, ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";

/**
 * The editable verification workspace -- separate from
 * /manager/receiving/[documentId] (document identity) on purpose: a
 * purchase document is a distinct business record from the source
 * document it was initialized from, per Milestone 2A.2's explicit
 * "avoid confusing document identity with invoice identity."
 *
 * Milestone 2A.2.1: this route now also serves every revision in a
 * business document's history (not just the current one) -- viewing a
 * superseded revision reuses the same VERIFIED branch with a "Superseded"
 * indicator, rather than a separate route.
 */
export const dynamic = "force-dynamic";

export default async function PurchaseDocumentPage({ params }: { params: Promise<{ purchaseDocumentId: string }> }) {
  const { purchaseDocumentId } = await params;
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const serviceClient = getServiceRoleClient();

  const { data: purchaseDocument } = await serviceClient
    .from("purchase_documents")
    .select(
      "id, source_document_id, source_extraction_id, vendor_id, document_type, document_number, document_date, po_number, delivery_date, subtotal, tax, fees, total, currency, status, version, created_by_app_user_id, verified_by_app_user_id, verified_at, last_returned_reason, last_returned_at, revision_group_id, revision_number, previous_revision_id, amendment_reason, discarded_by_app_user_id, discarded_at, discard_reason, updated_at"
    )
    .eq("id", purchaseDocumentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (!purchaseDocument) {
    notFound();
  }

  const { data: lines } = await serviceClient
    .from("purchase_document_lines")
    .select("line_key, vendor_sku, description, package_quantity, package_unit, measured_quantity, measured_unit, unit_price, price_basis_unit, line_total")
    .eq("purchase_document_id", purchaseDocumentId)
    .order("line_number");

  const { data: document } = await serviceClient
    .from("documents")
    .select("id, original_filename, content_type, uploaded_by_app_user_id, vendor_id, declared_document_type")
    .eq("id", purchaseDocument.source_document_id)
    .single();

  const { data: extractionAttempt } = await serviceClient
    .from("document_extractions")
    .select("normalized_extraction, review_flags, model")
    .eq("id", purchaseDocument.source_extraction_id)
    .single();

  const { data: latestSucceededAttempt } = await serviceClient
    .from("document_extractions")
    .select("attempt_number")
    .eq("document_id", purchaseDocument.source_document_id)
    .eq("status", "SUCCEEDED")
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: sourceExtractionAttemptNumber } = await serviceClient
    .from("document_extractions")
    .select("attempt_number")
    .eq("id", purchaseDocument.source_extraction_id)
    .single();

  // Every revision in this business document's history -- small (revisions
  // are rare), fetched in full (including DISCARDED rows -- they remain
  // permanently visible in Revision History, never hidden here) so the
  // summary/review views can show "Revision N of M" and a revision-history
  // list without extra round trips.
  const { data: allRevisions } = await serviceClient
    .from("purchase_documents")
    .select("id, revision_number, status, created_at, verified_at, discarded_by_app_user_id, discarded_at, discard_reason")
    .eq("revision_group_id", purchaseDocument.revision_group_id)
    .order("revision_number");

  const currentVerifiedRevisionNumber = (allRevisions ?? [])
    .filter((r) => r.status === "VERIFIED")
    .reduce<number | null>((max, r) => (max === null || r.revision_number > max ? r.revision_number : max), null);

  const discardedByIds = (allRevisions ?? [])
    .map((r) => r.discarded_by_app_user_id)
    .filter((id): id is string => Boolean(id));
  const { data: discardedByRows } =
    discardedByIds.length > 0
      ? await serviceClient.from("app_users").select("id, employees(first_name, last_name)").in("id", discardedByIds)
      : { data: [] };
  const discardedByNameById = new Map(
    (discardedByRows ?? []).map((row) => {
      const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
      return [row.id, employee ? `${employee.first_name} ${employee.last_name}` : null];
    })
  );

  const revisions: RevisionSummary[] = (allRevisions ?? []).map((r) => ({
    purchaseDocumentId: r.id,
    revisionNumber: r.revision_number,
    status: r.status,
    isCurrentVerified: r.status === "VERIFIED" && r.revision_number === currentVerifiedRevisionNumber,
    discardedByName: r.discarded_by_app_user_id ? (discardedByNameById.get(r.discarded_by_app_user_id) ?? null) : null,
    discardedAt: r.discarded_at,
    discardReason: r.discard_reason,
  }));

  const vendorIds = [purchaseDocument.vendor_id, document?.vendor_id].filter((id): id is string => Boolean(id));
  const { data: vendorRows } =
    vendorIds.length > 0 ? await serviceClient.from("vendors").select("id, name").in("id", vendorIds) : { data: [] };
  const vendorNameById = new Map((vendorRows ?? []).map((v) => [v.id, v.name as string]));

  const vendorsResult = await listVendors();

  // Maker-checker identity is now this REVISION's own preparer -- for
  // revision 1 this is structurally guaranteed equal to documents.
  // uploaded_by_app_user_id (see the migration); for an amendment revision
  // it's whoever initiated it, which may be a different person entirely.
  const isPreparer = purchaseDocument.created_by_app_user_id === auth.manager.appUserId;
  const isOriginalUploader = document?.uploaded_by_app_user_id === auth.manager.appUserId;

  const duplicates = await findPossibleDuplicatePurchaseDocuments(serviceClient, {
    organizationId: auth.manager.organizationId,
    vendorId: purchaseDocument.vendor_id,
    documentType: purchaseDocument.document_type,
    documentNumber: purchaseDocument.document_number,
    excludeRevisionGroupId: purchaseDocument.revision_group_id,
  });

  const normalized = (extractionAttempt?.normalized_extraction ?? null) as NormalizedInvoiceExtraction | null;

  const lineRows = (lines ?? []).map((line) => ({
    lineKey: line.line_key,
    vendorSku: line.vendor_sku,
    description: line.description,
    packageQuantity: line.package_quantity,
    packageUnit: line.package_unit,
    measuredQuantity: line.measured_quantity,
    measuredUnit: line.measured_unit,
    unitPrice: line.unit_price,
    priceBasisUnit: line.price_basis_unit,
    lineTotal: line.line_total,
    rawLineText: null,
  }));

  const headerRow = {
    vendorId: purchaseDocument.vendor_id,
    documentType: purchaseDocument.document_type,
    documentNumber: purchaseDocument.document_number,
    documentDate: purchaseDocument.document_date,
    poNumber: purchaseDocument.po_number,
    deliveryDate: purchaseDocument.delivery_date,
    subtotal: purchaseDocument.subtotal,
    tax: purchaseDocument.tax,
    fees: purchaseDocument.fees,
    total: purchaseDocument.total,
    currency: purchaseDocument.currency,
  };

  if (purchaseDocument.status === "DISCARDED") {
    return (
      <DiscardedPurchaseDocumentSummary
        purchaseDocumentId={purchaseDocument.id}
        originalFilename={document?.original_filename ?? "Document"}
        header={headerRow}
        lines={lineRows}
        revisionNumber={purchaseDocument.revision_number}
        discardedByName={
          purchaseDocument.discarded_by_app_user_id ? (discardedByNameById.get(purchaseDocument.discarded_by_app_user_id) ?? null) : null
        }
        discardedAt={purchaseDocument.discarded_at}
        discardReason={purchaseDocument.discard_reason}
        revisions={revisions}
      />
    );
  }

  // The physical delivery verifier -- an EMPLOYEE, never an app_user (they
  // never authenticate) -- captured once at upload, correctable afterward
  // (document_delivery_verifier_corrections). Distinct from "Final review
  // verified by," the second manager's own app-authenticated verification.
  // Needed on every branch now (Step 4's Review & Send summary shows it
  // too, not only the post-VERIFIED summary), so resolved once up front.
  let deliveryVerifiedByName: string | null = null;
  if (purchaseDocument.source_document_id) {
    const { data: deliveryVerifierEmployeeId } = await serviceClient.rpc("current_document_delivery_verifier_employee_id", {
      p_document_id: purchaseDocument.source_document_id,
      p_organization_id: auth.manager.organizationId,
    });
    if (deliveryVerifierEmployeeId) {
      const { data: employee } = await serviceClient
        .from("employees")
        .select("first_name, last_name")
        .eq("id", deliveryVerifierEmployeeId as string)
        .maybeSingle();
      deliveryVerifiedByName = employee ? `${employee.first_name} ${employee.last_name}` : null;
    }
  }

  // The preparer (Manager 1) -- needed by Step 4's Review & Send "People"
  // summary on the DRAFT/READY_FOR_VERIFICATION path too, not only the
  // post-VERIFIED summary (which already resolves its own preparerAppUser
  // further below), so resolved once up front the same way.
  let preparerName: string | null = null;
  {
    const { data: preparerAppUser } = await serviceClient
      .from("app_users")
      .select("id, employees(first_name, last_name)")
      .eq("id", purchaseDocument.created_by_app_user_id)
      .maybeSingle();
    const employee = preparerAppUser ? (Array.isArray(preparerAppUser.employees) ? preparerAppUser.employees[0] : preparerAppUser.employees) : null;
    preparerName = employee ? `${employee.first_name} ${employee.last_name}` : null;
  }

  if (purchaseDocument.status === "VERIFIED") {
    // Corrections indicator: read the VERIFIED event's own finalCorrectionCount
    // (computed once, server-side, at verify time -- never recomputed here).
    const { data: verifiedEvent } = await serviceClient
      .from("audit_events")
      .select("after_state, occurred_at")
      .eq("entity_type", "purchase_document")
      .eq("entity_id", purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_VERIFIED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const finalCorrectionCount = (verifiedEvent?.after_state as { finalCorrectionCount?: number } | undefined)?.finalCorrectionCount ?? 0;

    const { data: verifiedByAppUser } = purchaseDocument.verified_by_app_user_id
      ? await serviceClient.from("app_users").select("id, employees(first_name, last_name)").eq("id", purchaseDocument.verified_by_app_user_id).maybeSingle()
      : { data: null };
    const { data: preparerAppUser } = await serviceClient
      .from("app_users")
      .select("id, employees(first_name, last_name)")
      .eq("id", purchaseDocument.created_by_app_user_id)
      .maybeSingle();
    const { data: uploaderAppUser } = document?.uploaded_by_app_user_id
      ? await serviceClient.from("app_users").select("id, employees(first_name, last_name)").eq("id", document.uploaded_by_app_user_id).maybeSingle()
      : { data: null };

    const displayName = (row: { employees: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null } | null) => {
      if (!row) return null;
      const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
      return employee ? `${employee.first_name} ${employee.last_name}` : null;
    };

    return (
      <VerifiedPurchaseDocumentSummary
        purchaseDocumentId={purchaseDocument.id}
        documentId={purchaseDocument.source_document_id}
        originalFilename={document?.original_filename ?? "Document"}
        header={headerRow}
        lines={lineRows}
        vendorName={purchaseDocument.vendor_id ? (vendorNameById.get(purchaseDocument.vendor_id) ?? null) : null}
        verifiedAt={purchaseDocument.verified_at}
        verifiedByName={displayName(verifiedByAppUser)}
        preparedByName={displayName(preparerAppUser)}
        uploadedByName={displayName(uploaderAppUser)}
        deliveryVerifiedByName={deliveryVerifiedByName}
        isOriginalUploader={isOriginalUploader}
        finalCorrectionCount={finalCorrectionCount}
        revisionNumber={purchaseDocument.revision_number}
        amendmentReason={purchaseDocument.amendment_reason}
        isCurrentVerified={purchaseDocument.revision_number === currentVerifiedRevisionNumber}
        revisions={revisions}
      />
    );
  }

  // READY_FOR_VERIFICATION reviewer corrections need the immutable
  // submitted baseline to show "Submitted: X" vs. "Current: Y" and drive
  // the live correction-count preview -- plus any PERSISTED provisional
  // proposal overlay (mapping/receiving), so an accidental refresh never
  // loses the reviewer's pending corrections.
  let submittedHeader = headerRow;
  let submittedLines = lineRows;
  let initialMappingProposals: MappingProposals = {};
  let initialReceivingProposals: ReceivingProposals = {};
  let initialOverlayVersion = 0;
  if (purchaseDocument.status === "READY_FOR_VERIFICATION") {
    const { data: submittedEvent } = await serviceClient
      .from("audit_events")
      .select("id, after_state")
      .eq("entity_type", "purchase_document")
      .eq("entity_id", purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_SUBMITTED")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: overlay } = await serviceClient
      .from("purchase_document_review_proposals")
      .select("mapping_proposals, receiving_proposals, version, submission_audit_event_id")
      .eq("organization_id", auth.manager.organizationId)
      .eq("purchase_document_id", purchaseDocumentId)
      .maybeSingle();
    // A stale-bound overlay (an earlier submission's -- should be
    // impossible now that Return AND Withdraw both discard it) is never
    // surfaced as current review state: the reviewer starts clean and the
    // save RPC self-heals the dead row on the first save (expected
    // version 0).
    if (overlay && submittedEvent && overlay.submission_audit_event_id === submittedEvent.id) {
      initialMappingProposals = (overlay.mapping_proposals ?? {}) as typeof initialMappingProposals;
      initialReceivingProposals = (overlay.receiving_proposals ?? {}) as typeof initialReceivingProposals;
      initialOverlayVersion = Number(overlay.version);
    }
    const snapshot = submittedEvent?.after_state as Record<string, unknown> | undefined;
    if (snapshot) {
      submittedHeader = {
        vendorId: (snapshot.vendor_id as string | null) ?? null,
        documentType: (snapshot.document_type as typeof headerRow.documentType) ?? null,
        documentNumber: (snapshot.document_number as string | null) ?? null,
        documentDate: (snapshot.document_date as string | null) ?? null,
        poNumber: (snapshot.po_number as string | null) ?? null,
        deliveryDate: (snapshot.delivery_date as string | null) ?? null,
        subtotal: (snapshot.subtotal as number | null) ?? null,
        tax: (snapshot.tax as number | null) ?? null,
        fees: (snapshot.fees as number | null) ?? null,
        total: (snapshot.total as number | null) ?? null,
        currency: (snapshot.currency as string | null) ?? null,
      };
      submittedLines = ((snapshot.lines as Record<string, unknown>[] | undefined) ?? []).map((line) => ({
        lineKey: (line.line_key as string | null) ?? null,
        vendorSku: (line.vendor_sku as string | null) ?? null,
        description: (line.description as string | null) ?? null,
        packageQuantity: (line.package_quantity as number | null) ?? null,
        packageUnit: (line.package_unit as string | null) ?? null,
        measuredQuantity: (line.measured_quantity as number | null) ?? null,
        measuredUnit: (line.measured_unit as string | null) ?? null,
        unitPrice: (line.unit_price as number | null) ?? null,
        priceBasisUnit: (line.price_basis_unit as string | null) ?? null,
        lineTotal: (line.line_total as number | null) ?? null,
        rawLineText: null,
      }));
    }
  }

  return (
    <PurchaseDocumentReviewView
      purchaseDocumentId={purchaseDocument.id}
      documentId={purchaseDocument.source_document_id}
      currentAppUserId={auth.manager.appUserId}
      isPreparer={isPreparer}
      originalFilename={document?.original_filename ?? "Document"}
      contentType={document?.content_type ?? "application/pdf"}
      status={purchaseDocument.status as "DRAFT" | "READY_FOR_VERIFICATION"}
      version={purchaseDocument.version}
      revisionNumber={purchaseDocument.revision_number}
      header={headerRow}
      lines={lineRows}
      submittedHeader={submittedHeader}
      submittedLines={submittedLines}
      vendorName={purchaseDocument.vendor_id ? (vendorNameById.get(purchaseDocument.vendor_id) ?? null) : null}
      declaredVendorName={document?.vendor_id ? (vendorNameById.get(document.vendor_id) ?? null) : null}
      declaredDocumentType={document?.declared_document_type ?? null}
      aiSuggestedVendorName={normalized?.vendorName ?? null}
      aiSuggestedDocumentType={normalized?.documentType ?? null}
      aiWarnings={normalized?.warnings ?? []}
      aiReviewFlags={(extractionAttempt?.review_flags ?? []) as ReviewFlag[]}
      aiModel={extractionAttempt?.model ?? null}
      hasNewerExtraction={
        !!latestSucceededAttempt &&
        !!sourceExtractionAttemptNumber &&
        latestSucceededAttempt.attempt_number > sourceExtractionAttemptNumber.attempt_number
      }
      lastReturnedReason={purchaseDocument.last_returned_reason}
      lastReturnedAt={purchaseDocument.last_returned_at}
      initialDuplicates={duplicates}
      vendors={vendorsResult.ok ? vendorsResult.vendors : []}
      deliveryVerifiedByName={deliveryVerifiedByName}
      preparerName={preparerName}
      preparedAt={purchaseDocument.updated_at}
      initialMappingProposals={initialMappingProposals}
      initialReceivingProposals={initialReceivingProposals}
      initialOverlayVersion={initialOverlayVersion}
    />
  );
}
