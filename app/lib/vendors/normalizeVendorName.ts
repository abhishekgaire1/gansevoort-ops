/**
 * Simple deterministic normalization used to enforce exact-normalized-
 * duplicate vendor name prevention (vendors_org_normalized_name_key) and
 * for vendor suggestion matching -- not a fuzzy dedupe. "Baldor Foods" and
 * "  baldor   foods " normalize identically; "Baldor" and "Baldor
 * Specialty Foods" do not.
 */
export function normalizeVendorName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}
