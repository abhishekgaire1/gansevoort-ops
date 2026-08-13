import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PurchaseDocumentStatus, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";

/**
 * Non-blocking business-document duplicate warning -- distinct from, and
 * never a substitute for, the file-hash-based duplicate check at upload
 * time (see initiateDocumentUpload's clientComputedSha256 handling). That
 * check catches "the same file bytes were uploaded twice"; this one catches
 * "two different documents describe the same business transaction" --
 * (organization_id, vendor_id, document_type, document_number) is the match
 * key, generic across INVOICE/RECEIPT/CREDIT_MEMO because document_type is
 * itself part of the key: an INVOICE #123 from Vendor A never collides with
 * a RECEIPT #123 from Vendor A, or an INVOICE #123 from Vendor B, without
 * any type-specific branching. Matches purchase_documents at any active
 * lifecycle status (DRAFT/READY_FOR_VERIFICATION/VERIFIED) -- a duplicate
 * already in someone else's draft is just as worth surfacing as a verified
 * one -- but never a DISCARDED row: an accidental draft the preparer
 * already discarded must not keep warning users about it forever.
 */

export interface PossibleDuplicatePurchaseDocument {
  purchaseDocumentId: string;
  documentNumber: string;
  documentDate: string | null;
  status: PurchaseDocumentStatus;
}

export interface FindPossibleDuplicatesInput {
  organizationId: string;
  vendorId: string | null;
  documentType: PurchaseDocumentType | null;
  documentNumber: string | null;
  /** Excluded from its own duplicate results -- omit when checking a draft
   * that doesn't have a purchase_document row yet. */
  excludePurchaseDocumentId?: string;
  /** Every revision sharing this group is excluded, not just the single
   * row identified by excludePurchaseDocumentId -- an amendment
   * intentionally carries the same (vendor, type, number) as the revision
   * it supersedes, and must never be flagged as a duplicate of its own
   * revision family. Omit when checking a draft that doesn't have a
   * purchase_document row (and therefore no revision_group_id) yet. */
  excludeRevisionGroupId?: string;
}

const REAL_DOCUMENT_TYPES: PurchaseDocumentType[] = ["INVOICE", "RECEIPT", "CREDIT_MEMO"];

/** Only check once vendor, a real document type, and a non-blank document
 * number are all known -- an incomplete draft has nothing meaningful to
 * compare yet, and checking against a null/blank number would match every
 * other equally-incomplete draft in the organization. */
export function isEligibleForDuplicateCheck(
  input: Pick<FindPossibleDuplicatesInput, "vendorId" | "documentType" | "documentNumber">
): boolean {
  return (
    Boolean(input.vendorId) &&
    Boolean(input.documentType && REAL_DOCUMENT_TYPES.includes(input.documentType)) &&
    Boolean(input.documentNumber && input.documentNumber.trim())
  );
}

export async function findPossibleDuplicatePurchaseDocuments(
  serviceClient: SupabaseClient,
  input: FindPossibleDuplicatesInput
): Promise<PossibleDuplicatePurchaseDocument[]> {
  if (!isEligibleForDuplicateCheck(input)) {
    return [];
  }

  let query = serviceClient
    .from("purchase_documents")
    .select("id, document_number, document_date, status")
    .eq("organization_id", input.organizationId)
    .eq("vendor_id", input.vendorId as string)
    .eq("document_type", input.documentType as string)
    .eq("document_number", (input.documentNumber as string).trim())
    // A discarded accidental draft is never a "real" match -- it must not
    // keep warning users forever. VERIFIED/current legitimate records
    // still participate normally.
    .neq("status", "DISCARDED")
    .order("created_at", { ascending: false })
    .limit(10);

  if (input.excludeRevisionGroupId) {
    query = query.neq("revision_group_id", input.excludeRevisionGroupId);
  } else if (input.excludePurchaseDocumentId) {
    query = query.neq("id", input.excludePurchaseDocumentId);
  }

  const { data } = await query;

  return (data ?? []).map((row) => ({
    purchaseDocumentId: row.id as string,
    documentNumber: row.document_number as string,
    documentDate: row.document_date as string | null,
    status: row.status as PurchaseDocumentStatus,
  }));
}
