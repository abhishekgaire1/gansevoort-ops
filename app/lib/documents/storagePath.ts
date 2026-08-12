import "server-only";

export { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

/**
 * Pure, server-only path builder -- deliberately takes no vendor/date/
 * invoice-number parameter, since that data may be unknown or wrong at
 * upload time and must never affect where the object physically lives.
 * organizationId and documentId are always server-resolved/generated, never
 * client-supplied, so the resulting path can't be steered by the caller.
 */
export function buildStoragePath(organizationId: string, documentId: string, extension: string): string {
  return `org/${organizationId}/documents/${documentId}/original.${extension}`;
}
