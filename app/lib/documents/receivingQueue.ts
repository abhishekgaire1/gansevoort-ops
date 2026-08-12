import "server-only";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import type { LatestAttemptForStatus } from "@/app/lib/documents/documentStatus";

export interface ReceivingQueueItem {
  documentId: string;
  originalFilename: string;
  createdAt: string;
  latestAttempt:
    | (LatestAttemptForStatus & {
        vendorName: string | null;
        invoiceNumber: string | null;
      })
    | null;
}

/**
 * documents has no status column -- this fetches each document's newest
 * (highest attempt_number) document_extractions row in application code,
 * since the Supabase JS client has no clean "latest row per group" query.
 * Shared by the receiving queue and (indirectly, via the same shape) the
 * document detail page's queue-context needs.
 */
export async function getReceivingQueue(organizationId: string): Promise<ReceivingQueueItem[]> {
  const serviceClient = getServiceRoleClient();

  const { data: documents } = await serviceClient
    .from("documents")
    .select("id, original_filename, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!documents || documents.length === 0) {
    return [];
  }

  const documentIds = documents.map((document) => document.id);

  const { data: attempts } = await serviceClient
    .from("document_extractions")
    .select("document_id, status, requested_at, started_at, normalized_extraction")
    .in("document_id", documentIds)
    .order("attempt_number", { ascending: false });

  const latestByDocument = new Map<string, NonNullable<typeof attempts>[number]>();
  for (const attempt of attempts ?? []) {
    if (!latestByDocument.has(attempt.document_id)) {
      latestByDocument.set(attempt.document_id, attempt);
    }
  }

  return documents.map((document) => {
    const attempt = latestByDocument.get(document.id);
    const normalized = attempt?.normalized_extraction as { vendorName?: string | null; invoiceNumber?: string | null } | null;

    return {
      documentId: document.id,
      originalFilename: document.original_filename,
      createdAt: document.created_at,
      latestAttempt: attempt
        ? {
            status: attempt.status,
            requestedAt: attempt.requested_at,
            startedAt: attempt.started_at,
            vendorName: normalized?.vendorName ?? null,
            invoiceNumber: normalized?.invoiceNumber ?? null,
          }
        : null,
    };
  });
}
