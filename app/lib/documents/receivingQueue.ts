import "server-only";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
import type { PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";

export interface ReceivingQueueFilters {
  vendorId?: string;
  uploadedByAppUserId?: string;
  status?: ReceivingItemStatus;
  documentType?: PurchaseDocumentType;
  /** Inclusive, ISO yyyy-mm-dd. */
  dateFrom?: string;
  dateTo?: string;
  dateType?: "business" | "uploaded";
  q?: string;
}

export interface ReceivingQueueItem {
  documentId: string;
  purchaseDocumentId: string | null;
  originalFilename: string;
  createdAt: string;
  uploadedByAppUserId: string;
  uploadedByName: string;
  /** "Corrected" business data once a purchase_document exists (any
   * status), else falls back to the declared-at-intake documents fields --
   * never Gemini's unverified guess. */
  vendorId: string | null;
  vendorName: string | null;
  documentType: PurchaseDocumentType | null;
  documentNumber: string | null;
  documentDate: string | null;
  /** Non-null only when the effective value above differs from what was
   * originally declared at upload -- drives the "Originally selected: X"
   * note. */
  originalVendorName: string | null;
  originalDocumentType: PurchaseDocumentType | null;
  verifiedByName: string | null;
  status: ReceivingItemStatus;
  /** The EFFECTIVE workflow revision's own number -- open (DRAFT/READY)
   * revision if one exists, else the current verified revision. Never to
   * be confused with currentVerifiedRevisionNumber below. Null when no
   * purchase_document exists yet. */
  revisionNumber: number | null;
  /** The CURRENT VERIFIED revision's number (highest revision_number with
   * status=VERIFIED in this business document's revision group) --
   * authoritative business truth, independent of whatever the effective
   * workflow revision happens to be. Null if nothing has ever been
   * verified yet. Differs from revisionNumber exactly when an amendment
   * is in progress (effective = the open draft/ready amendment,
   * current-verified = the still-authoritative prior revision). */
  currentVerifiedRevisionNumber: number | null;
  /** True only when the effective revision is itself an in-progress
   * amendment (revisionNumber > 1 and status is DRAFT or
   * READY_FOR_VERIFICATION) -- drives the "AMENDMENT DRAFT/READY · REV N"
   * badge. A first-time draft/ready document (no prior verified revision)
   * is never an amendment. */
  isAmendmentInProgress: boolean;
}

interface EmployeeNameRow {
  id: string;
  employees: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
}

function displayName(row: EmployeeNameRow | undefined): string {
  if (!row) return "Unknown";
  const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
  return employee ? `${employee.first_name} ${employee.last_name}` : "Unknown";
}

const QUEUE_RESULT_LIMIT = 200;

interface SearchReceivingQueueRow {
  out_document_id: string;
  out_original_filename: string;
  out_content_type: string;
  out_created_at: string;
  out_uploaded_by_app_user_id: string;
  out_purchase_document_id: string | null;
  out_effective_vendor_id: string | null;
  out_effective_document_type: PurchaseDocumentType | null;
  out_declared_vendor_id: string | null;
  out_declared_document_type: PurchaseDocumentType | null;
  out_document_number: string | null;
  out_document_date: string | null;
  out_status: ReceivingItemStatus;
  out_verified_by_app_user_id: string | null;
  out_revision_number: number | null;
  out_current_verified_revision_number: number | null;
}

/**
 * All filtering happens INSIDE the search_receiving_queue SQL function
 * (see supabase/migrations/20260811100028_receiving_queue_search.sql),
 * before its own LIMIT -- a match older than the QUEUE_RESULT_LIMIT most
 * recent uploads is never silently dropped, unlike the earlier version of
 * this file, which limited the raw `documents` query first and filtered in
 * JS afterward. "Prefer purchase_documents' corrected data once it exists,
 * else fall back to the documents-level intake declaration," the workflow
 * status derivation, and every filter predicate all live in that SQL
 * function now. This file's remaining job is purely display-name
 * resolution (vendor/uploader/verifier names), which is cheap now that
 * it's batched against an already-filtered, already-bounded result set
 * instead of the full unfiltered top-200.
 */
export async function getReceivingQueue(organizationId: string, filters: ReceivingQueueFilters = {}): Promise<ReceivingQueueItem[]> {
  const serviceClient = getServiceRoleClient();

  const { data, error } = await serviceClient.rpc("search_receiving_queue", {
    p_organization_id: organizationId,
    p_vendor_id: filters.vendorId ?? null,
    p_uploaded_by_app_user_id: filters.uploadedByAppUserId ?? null,
    p_status: filters.status ?? null,
    p_document_type: filters.documentType ?? null,
    p_date_type: filters.dateType ?? "uploaded",
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    p_query: filters.q ?? null,
    p_limit: QUEUE_RESULT_LIMIT,
  });

  if (error) {
    // Never silently degrade to an empty queue -- a transient DB error
    // must surface as an error, not as "there are no documents" (a
    // manager acting on a silently-empty queue is far worse than seeing
    // a failure they can retry). Discovered during 2A.4: under heavy
    // concurrent load the swallowed error made the whole Receiving Queue
    // read as empty with no signal anywhere.
    throw new Error(`search_receiving_queue failed: ${error.message}`);
  }
  const results = (data ?? []) as SearchReceivingQueueRow[];
  if (results.length === 0) {
    return [];
  }

  const vendorIds = new Set<string>();
  const appUserIds = new Set<string>();
  for (const row of results) {
    if (row.out_effective_vendor_id) vendorIds.add(row.out_effective_vendor_id);
    if (row.out_declared_vendor_id) vendorIds.add(row.out_declared_vendor_id);
    appUserIds.add(row.out_uploaded_by_app_user_id);
    if (row.out_verified_by_app_user_id) appUserIds.add(row.out_verified_by_app_user_id);
  }

  const { data: vendors } =
    vendorIds.size > 0 ? await serviceClient.from("vendors").select("id, name").in("id", Array.from(vendorIds)) : { data: [] };
  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id, v.name as string]));

  const { data: appUserRows } =
    appUserIds.size > 0
      ? await serviceClient.from("app_users").select("id, employees(first_name, last_name)").in("id", Array.from(appUserIds))
      : { data: [] };
  const nameByAppUserId = new Map<string, string>();
  for (const row of (appUserRows ?? []) as EmployeeNameRow[]) {
    nameByAppUserId.set(row.id, displayName(row));
  }

  return results.map((row) => {
    const hasPurchaseDocument = Boolean(row.out_purchase_document_id);
    return {
      documentId: row.out_document_id,
      purchaseDocumentId: row.out_purchase_document_id,
      originalFilename: row.out_original_filename,
      createdAt: row.out_created_at,
      uploadedByAppUserId: row.out_uploaded_by_app_user_id,
      uploadedByName: nameByAppUserId.get(row.out_uploaded_by_app_user_id) ?? "Unknown",
      vendorId: row.out_effective_vendor_id,
      vendorName: row.out_effective_vendor_id ? (vendorNameById.get(row.out_effective_vendor_id) ?? null) : null,
      documentType: row.out_effective_document_type,
      documentNumber: row.out_document_number,
      documentDate: row.out_document_date,
      originalVendorName:
        hasPurchaseDocument && row.out_declared_vendor_id && row.out_declared_vendor_id !== row.out_effective_vendor_id
          ? (vendorNameById.get(row.out_declared_vendor_id) ?? null)
          : null,
      originalDocumentType:
        hasPurchaseDocument && row.out_declared_document_type && row.out_declared_document_type !== row.out_effective_document_type
          ? row.out_declared_document_type
          : null,
      verifiedByName: row.out_verified_by_app_user_id ? (nameByAppUserId.get(row.out_verified_by_app_user_id) ?? null) : null,
      status: row.out_status,
      revisionNumber: row.out_revision_number,
      currentVerifiedRevisionNumber: row.out_current_verified_revision_number,
      isAmendmentInProgress:
        row.out_status !== "VERIFIED" &&
        row.out_revision_number !== null &&
        row.out_revision_number > 1 &&
        row.out_current_verified_revision_number !== null,
    };
  });
}
