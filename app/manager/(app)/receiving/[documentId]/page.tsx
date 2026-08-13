import { notFound } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { DocumentDetailView } from "./_components/DocumentDetailView";

/**
 * Original document / latest extraction / review flags / extraction
 * history. Explicitly not editable -- no input fields, only view/download
 * and Retry Extraction; manager corrections to extracted data start in a
 * later milestone once verified invoice drafts exist.
 */
export const dynamic = "force-dynamic";

export default async function DocumentDetailPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const serviceClient = getServiceRoleClient();

  // Filtered by both id AND the manager's own organization_id -- a
  // cross-org id gets the same 404 as a nonexistent one.
  const { data: document } = await serviceClient
    .from("documents")
    .select("id, original_filename, content_type, created_at, uploaded_by_app_user_id")
    .eq("id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (!document) {
    notFound();
  }

  // documents is fully append-only (see 20260811100018) -- "archived" is
  // never a column on it, only derived by an outer-joined existence check
  // against the separate document_archives table (20260811100034).
  const { data: archiveRow } = await serviceClient.from("document_archives").select("document_id").eq("document_id", documentId).maybeSingle();

  const { data: attempts } = await serviceClient
    .from("document_extractions")
    .select("id, attempt_number, status, requested_at, started_at, completed_at, model, normalized_extraction, review_flags, error_code")
    .eq("document_id", documentId)
    .order("attempt_number", { ascending: false });

  // A source document may now back MULTIPLE purchase_document rows
  // (revisions) -- fetch them all, ordered highest-revision first, rather
  // than the single-row query this predates, which would error the
  // instant a real amendment or discarded revision existed for this
  // document.
  const { data: purchaseDocuments } = await serviceClient
    .from("purchase_documents")
    .select("id, status, revision_number")
    .eq("source_document_id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .order("revision_number", { ascending: false });

  // The "effective" one for the Open Draft/View Submission/View Verified
  // button -- same "prefer an open non-discarded row, else the highest
  // discarded/verified one" spirit as search_receiving_queue, simplified
  // since this page only needs a single id/status pair, not a full queue
  // row.
  const activePurchaseDocument = (purchaseDocuments ?? []).find((pd) => pd.status !== "DISCARDED") ?? null;
  // Once revision 1 has ever been discarded, the partial unique index on
  // (organization_id, source_document_id) where revision_number = 1
  // permanently forbids creating a new one from this same document --
  // "Create Purchase Document Draft" must not be offered in that case.
  const hasDiscardedRevisionOne = (purchaseDocuments ?? []).some((pd) => pd.revision_number === 1 && pd.status === "DISCARDED");
  // Removable only once every purchase_document ever created here (if any)
  // is discarded -- mirrors archive_document's own DB-level check.
  const canRemoveUpload = !archiveRow && (purchaseDocuments ?? []).every((pd) => pd.status === "DISCARDED");

  return (
    <DocumentDetailView
      documentId={document.id}
      originalFilename={document.original_filename}
      contentType={document.content_type}
      purchaseDocumentId={activePurchaseDocument?.id ?? null}
      purchaseDocumentStatus={activePurchaseDocument?.status ?? null}
      hasDiscardedRevisionOne={hasDiscardedRevisionOne}
      canRemoveUpload={canRemoveUpload}
      isArchived={Boolean(archiveRow)}
      isUploader={document.uploaded_by_app_user_id === auth.manager.appUserId}
      attempts={(attempts ?? []).map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attempt_number,
        status: attempt.status,
        requestedAt: attempt.requested_at,
        startedAt: attempt.started_at,
        completedAt: attempt.completed_at,
        model: attempt.model,
        normalizedExtraction: attempt.normalized_extraction,
        reviewFlags: attempt.review_flags ?? [],
        errorCode: attempt.error_code,
      }))}
    />
  );
}
