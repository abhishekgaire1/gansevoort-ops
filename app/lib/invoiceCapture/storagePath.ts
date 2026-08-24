import "server-only";

export { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

/**
 * Reuses the EXISTING private receiving-documents bucket (Phase A: no
 * bucket-creation migration exists anywhere in this project -- Storage
 * buckets aren't managed through SQL migrations here, and adding a
 * second bucket would require an undocumented manual Dashboard step this
 * milestone deliberately avoids). Captures live under a clearly distinct
 * org/<org>/captures/<session>/ prefix so temporary capture evidence and
 * promoted, authoritative document evidence (org/<org>/documents/<id>/)
 * can never be confused by path alone. Pure/server-only, same shape as
 * app/lib/documents/storagePath.ts -- organizationId/sessionId are always
 * server-resolved, never client-supplied.
 */
export function buildCaptureStoragePath(organizationId: string, sessionId: string, pageNumber: number, extension: string): string {
  return `org/${organizationId}/captures/${sessionId}/page-${pageNumber}.${extension}`;
}
