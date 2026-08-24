/**
 * Phone-to-Desktop Invoice Capture milestone -- shared constants. Not
 * "server-only": the expiry minutes value is safe/useful to show in
 * desktop copy ("This code expires in 10 minutes"), and the max-file-size
 * value drives client-side pre-validation on the phone before it even
 * attempts an upload.
 */

/** Part 8: 10 minutes, matching the milestone spec's own default -- no
 * existing short-lived-token convention in this project suggested a
 * different value. */
export const CAPTURE_SESSION_EXPIRY_MINUTES = 10;

/** Same ceiling as the existing desktop upload pipeline
 * (app/actions/documentUpload.ts's MAX_FILE_BYTES) -- one consistent
 * limit across every source-document ingestion path, comfortably above
 * what a modern phone camera JPEG produces (typically 2-8MB even at full
 * resolution), never an arbitrary smaller number that would reject
 * ordinary photos (Part 58). */
export const CAPTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const CAPTURE_MAX_FILE_MB = CAPTURE_MAX_FILE_BYTES / (1024 * 1024);

/** Phone capture accepts only what the existing backend can actually
 * process (Phase A: sniffMimeType only recognizes JPEG/PNG/PDF -- no HEIC
 * support exists anywhere in the current pipeline). A modern mobile
 * browser's <input capture> flow already hands back a JPEG blob from the
 * native camera UI in every mainstream case, so this is not a real-world
 * limitation for the primary flow -- it is a deliberate choice not to add
 * a HEIC-conversion dependency for this milestone (Part 11). */
export const CAPTURE_ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png"] as const;
