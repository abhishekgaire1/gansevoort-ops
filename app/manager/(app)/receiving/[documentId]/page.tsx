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
    .select("id, original_filename, content_type, created_at")
    .eq("id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (!document) {
    notFound();
  }

  const { data: attempts } = await serviceClient
    .from("document_extractions")
    .select("id, attempt_number, status, requested_at, started_at, completed_at, model, normalized_extraction, review_flags, error_code")
    .eq("document_id", documentId)
    .order("attempt_number", { ascending: false });

  const { data: purchaseDocument } = await serviceClient
    .from("purchase_documents")
    .select("id, status")
    .eq("source_document_id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  return (
    <DocumentDetailView
      documentId={document.id}
      originalFilename={document.original_filename}
      contentType={document.content_type}
      purchaseDocumentId={purchaseDocument?.id ?? null}
      purchaseDocumentStatus={purchaseDocument?.status ?? null}
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
