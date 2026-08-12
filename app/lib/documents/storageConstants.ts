/**
 * No "server-only" guard, unlike storagePath.ts -- this is just the bucket
 * name string, safe to reference from the client-side upload component
 * (which needs it to call the Supabase Storage SDK's uploadToSignedUrl
 * against the right bucket), not a secret.
 */
export const RECEIVING_DOCUMENTS_BUCKET = "receiving-documents";
