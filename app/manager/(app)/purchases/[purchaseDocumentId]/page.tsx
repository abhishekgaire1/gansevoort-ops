import { notFound } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listVendors } from "@/app/actions/vendors";
import { findPossibleDuplicatePurchaseDocuments } from "@/app/lib/purchaseDocuments/duplicateDetection";
import { PurchaseDocumentReviewView } from "./_components/PurchaseDocumentReviewView";
import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * The editable verification workspace -- separate from
 * /manager/receiving/[documentId] (document identity) on purpose: a
 * purchase document is a distinct business record from the source
 * document it was initialized from, per Milestone 2A.2's explicit
 * "avoid confusing document identity with invoice identity."
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
      "id, source_document_id, source_extraction_id, vendor_id, document_type, document_number, document_date, po_number, delivery_date, subtotal, tax, fees, total, currency, status, version, verified_by_app_user_id, verified_at, last_returned_reason, last_returned_at"
    )
    .eq("id", purchaseDocumentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (!purchaseDocument) {
    notFound();
  }

  const { data: lines } = await serviceClient
    .from("purchase_document_lines")
    .select("vendor_sku, description, package_quantity, package_unit, measured_quantity, measured_unit, unit_price, price_basis_unit, line_total")
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

  const vendorIds = [purchaseDocument.vendor_id, document?.vendor_id].filter((id): id is string => Boolean(id));
  const { data: vendorRows } =
    vendorIds.length > 0 ? await serviceClient.from("vendors").select("id, name").in("id", vendorIds) : { data: [] };
  const vendorNameById = new Map((vendorRows ?? []).map((v) => [v.id, v.name as string]));

  const vendorsResult = await listVendors();

  const isPreparer = document?.uploaded_by_app_user_id === auth.manager.appUserId;

  const duplicates = await findPossibleDuplicatePurchaseDocuments(serviceClient, {
    organizationId: auth.manager.organizationId,
    vendorId: purchaseDocument.vendor_id,
    documentType: purchaseDocument.document_type,
    documentNumber: purchaseDocument.document_number,
    excludePurchaseDocumentId: purchaseDocument.id,
  });

  const normalized = (extractionAttempt?.normalized_extraction ?? null) as NormalizedInvoiceExtraction | null;

  return (
    <PurchaseDocumentReviewView
      purchaseDocumentId={purchaseDocument.id}
      documentId={purchaseDocument.source_document_id}
      currentAppUserId={auth.manager.appUserId}
      isPreparer={isPreparer}
      originalFilename={document?.original_filename ?? "Document"}
      contentType={document?.content_type ?? "application/pdf"}
      status={purchaseDocument.status}
      version={purchaseDocument.version}
      header={{
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
      }}
      lines={(lines ?? []).map((line) => ({
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
      }))}
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
      verifiedByAppUserId={purchaseDocument.verified_by_app_user_id}
      verifiedAt={purchaseDocument.verified_at}
      initialDuplicates={duplicates}
      lastReturnedReason={purchaseDocument.last_returned_reason}
      lastReturnedAt={purchaseDocument.last_returned_at}
      vendors={vendorsResult.ok ? vendorsResult.vendors : []}
    />
  );
}
