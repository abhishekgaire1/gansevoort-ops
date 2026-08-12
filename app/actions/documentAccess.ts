"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storagePath";
import { buildArchiveFilename } from "@/app/lib/documents/archiveFilename";

/**
 * View and download are deliberately separate actions/URLs (never one
 * link reused for both): the viewer must load inline for the document
 * pane, so it must NOT carry a Content-Disposition download filename,
 * which some browsers honor even for <img>/<embed> and would force a
 * save-file prompt instead of rendering.
 */
const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes, refresh-on-demand -- no client-side countdown/auto-refresh timer for this inspection screen.

export type DocumentUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not_authorized" | "not_found" | "misconfigured"; message: string };

interface ResolvedDocument {
  ok: true;
  serviceClient: SupabaseClient;
  storagePath: string;
  originalFilename: string;
}
interface UnresolvedDocument {
  ok: false;
  reason: "not_authorized" | "not_found";
}

async function resolveOwnedDocument(documentId: string): Promise<ResolvedDocument | UnresolvedDocument> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized" };
  }

  const serviceClient = getServiceRoleClient();
  // Filtered by both id AND the session's own organization_id -- a
  // mismatched org gets the same generic "not found" as a nonexistent id,
  // never leaking cross-org existence.
  const { data: document, error } = await serviceClient
    .from("documents")
    .select("storage_path, original_filename")
    .eq("id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (error || !document) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true, serviceClient, storagePath: document.storage_path, originalFilename: document.original_filename };
}

function unresolvedToResult(resolved: UnresolvedDocument): DocumentUrlResult {
  return {
    ok: false,
    reason: resolved.reason,
    message: resolved.reason === "not_authorized" ? "You must be signed in as a manager or admin." : "Document not found.",
  };
}

/** Inline viewing only (img/embed/iframe source) -- no download option. */
export async function getDocumentViewUrl(documentId: string): Promise<DocumentUrlResult> {
  const resolved = await resolveOwnedDocument(documentId);
  if (!resolved.ok) return unresolvedToResult(resolved);

  const { data, error } = await resolved.serviceClient.storage
    .from(RECEIVING_DOCUMENTS_BUCKET)
    .createSignedUrl(resolved.storagePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data) {
    return { ok: false, reason: "misconfigured", message: "Could not load the document. Try again." };
  }

  return { ok: true, url: data.signedUrl };
}

/** Explicit download only -- carries the friendly, derived archive filename
 * via Storage's `download` option; never renames the underlying object. */
export async function getDocumentDownloadUrl(documentId: string): Promise<DocumentUrlResult> {
  const resolved = await resolveOwnedDocument(documentId);
  if (!resolved.ok) return unresolvedToResult(resolved);

  const friendlyFilename = buildArchiveFilename({
    vendorName: null,
    invoiceDate: null,
    invoiceNumber: null,
    originalFilename: resolved.originalFilename,
  });

  const { data, error } = await resolved.serviceClient.storage
    .from(RECEIVING_DOCUMENTS_BUCKET)
    .createSignedUrl(resolved.storagePath, SIGNED_URL_TTL_SECONDS, { download: friendlyFilename });

  if (error || !data) {
    return { ok: false, reason: "misconfigured", message: "Could not prepare the download. Try again." };
  }

  return { ok: true, url: data.signedUrl };
}
