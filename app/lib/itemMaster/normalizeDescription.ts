/** Same deterministic trim/collapse-whitespace/uppercase recipe as
 * app/lib/vendors/normalizeVendorName.ts, applied to a vendor's line
 * description instead of a vendor name -- exact-normalized matching, not
 * fuzzy. Used both for vendor_item_mappings.normalized_description writes
 * and for looking one up. */
export function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ").toUpperCase();
}
