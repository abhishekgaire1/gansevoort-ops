"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storagePath";
import { buildArchiveFilename } from "@/app/lib/documents/archiveFilename";
import { listDocumentPagesRpc } from "@/app/lib/documents/listDocumentPagesRpc";

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
  organizationId: string;
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

  return {
    ok: true,
    serviceClient,
    organizationId: auth.manager.organizationId,
    storagePath: document.storage_path,
    originalFilename: document.original_filename,
  };
}

function unresolvedToResult(resolved: UnresolvedDocument): { ok: false; reason: "not_authorized" | "not_found"; message: string } {
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
 * via Storage's `download` option; never renames the underlying object.
 * Uses verified purchase_document data (vendor/type/number/date) once it
 * exists -- never Gemini's unverified guess -- falling back to the
 * original filename until (and unless) a VERIFIED record exists. */
export async function getDocumentDownloadUrl(documentId: string): Promise<DocumentUrlResult> {
  const resolved = await resolveOwnedDocument(documentId);
  if (!resolved.ok) return unresolvedToResult(resolved);

  const { data: verified } = await resolved.serviceClient
    .from("purchase_documents")
    .select("vendor_id, document_type, document_number, document_date")
    .eq("source_document_id", documentId)
    .eq("status", "VERIFIED")
    .maybeSingle();

  let verifiedVendorName: string | null = null;
  if (verified?.vendor_id) {
    const { data: vendor } = await resolved.serviceClient.from("vendors").select("name").eq("id", verified.vendor_id).maybeSingle();
    verifiedVendorName = vendor?.name ?? null;
  }

  const friendlyFilename = buildArchiveFilename({
    vendorName: verifiedVendorName,
    documentDate: verified?.document_date ?? null,
    documentNumber: verified?.document_number ?? null,
    documentType: (verified?.document_type as "INVOICE" | "RECEIPT" | "CREDIT_MEMO" | null) ?? null,
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

export type DocumentPageViewUrlsResult =
  | { ok: true; pages: { pageNumber: number; url: string; contentType: string }[] }
  | { ok: false; reason: "not_authorized" | "not_found" | "misconfigured"; message: string };

/** Multi-page capture (100127): every page of a document, in order, each
 * with its own inline-viewing signed URL (same TTL/no-download-header
 * pattern as getDocumentViewUrl). A single-page document -- every
 * document created before 100127, and the overwhelming majority created
 * after it -- returns exactly one page. */
export async function getDocumentPageViewUrls(documentId: string): Promise<DocumentPageViewUrlsResult> {
  const resolved = await resolveOwnedDocument(documentId);
  if (!resolved.ok) return unresolvedToResult(resolved);

  const docPages = await listDocumentPagesRpc(resolved.serviceClient, resolved.organizationId, documentId);
  if (docPages.length === 0) {
    return { ok: false, reason: "not_found", message: "Document not found." };
  }

  const pages: { pageNumber: number; url: string; contentType: string }[] = [];
  for (const page of docPages) {
    const { data, error } = await resolved.serviceClient.storage.from(RECEIVING_DOCUMENTS_BUCKET).createSignedUrl(page.storagePath, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      return { ok: false, reason: "misconfigured", message: "Could not load the document. Try again." };
    }
    pages.push({ pageNumber: page.pageNumber, url: data.signedUrl, contentType: page.contentType });
  }

  return { ok: true, pages };
}
