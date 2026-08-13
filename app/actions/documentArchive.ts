"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { archiveDocumentRpc } from "@/app/lib/documents/archiveDocumentRpc";
import { NotPreparerError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";

/**
 * "Remove Upload" -- for an accidental upload that never became a real
 * purchase_document (or whose only purchase_document has itself been
 * discarded). Never a hard delete, and never a mutation of `documents`
 * itself (that table is fully append-only) -- inserts one row into the
 * separate document_archives table, which is what hides it from the
 * Receiving Queue; the original storage object is retained, no physical
 * purge in this milestone.
 */

export type ArchiveDocumentActionResult =
  | { ok: true; archivedAt: string }
  | { ok: false; reason: "not_authorized" | "not_uploader" | "not_archivable"; message: string };

export async function archiveDocument(documentId: string, reason?: string): Promise<ArchiveDocumentActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  try {
    const result = await archiveDocumentRpc(getServiceRoleClient(), {
      documentId,
      organizationId: auth.manager.organizationId,
      appUserId: auth.manager.appUserId,
      reason,
    });
    return { ok: true, archivedAt: result.archivedAt };
  } catch (err) {
    if (err instanceof NotPreparerError) {
      return { ok: false, reason: "not_uploader", message: "Only the manager who uploaded this document can remove it." };
    }
    if (err instanceof StaleVersionError) {
      return { ok: false, reason: "not_archivable", message: "This document backs an active purchase record and cannot be removed." };
    }
    return { ok: false, reason: "not_archivable", message: "Something went wrong. Try again." };
  }
}
