/**
 * Never stored -- computed on demand at signed-download-URL generation
 * time. Milestone 2A.1 has no verified invoice data yet (that starts in
 * 2A.2), so every call site passes nulls for vendorName/invoiceDate/
 * invoiceNumber today and this always falls back to the original filename;
 * the shape exists now so a later verification milestone can start passing
 * real values without any change to the download path itself.
 */
export function buildArchiveFilename(input: {
  vendorName: string | null;
  invoiceDate: string | null;
  invoiceNumber: string | null;
  originalFilename: string;
}): string {
  const lastDot = input.originalFilename.lastIndexOf(".");
  const extension = lastDot > 0 ? input.originalFilename.slice(lastDot) : "";

  const parts = [input.vendorName, input.invoiceDate, input.invoiceNumber].filter(
    (part): part is string => Boolean(part && part.trim())
  );

  if (parts.length === 0) {
    return input.originalFilename;
  }

  const sanitized = parts.map((part) => part.trim().replace(/[^a-zA-Z0-9._-]+/g, "_"));
  return `${sanitized.join("_")}${extension}`;
}
