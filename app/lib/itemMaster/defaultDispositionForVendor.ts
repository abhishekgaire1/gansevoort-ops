/**
 * Vendor-aware DEFAULT for a new item proposal's disposition (vendor
 * classification feature). A NON_INVENTORY vendor's lines start from
 * "Non-inventory" regardless of the AI proposal -- the vendor identity
 * is stronger evidence than a description-only guess for suppliers that
 * sell office supplies, cleaning products, services, etc. An INVENTORY
 * vendor's lines keep the pre-existing behavior exactly: the AI
 * proposal, else "INVENTORY".
 *
 * This is ONLY the form default. The disposition select is always
 * visible whenever the value is NON_INVENTORY
 * (shouldShowDispositionControl), so the manager always sees and can
 * override it per line -- an inventory item bought from an expense
 * vendor, or an expense line on a food invoice, both stay one click
 * away. Never a restriction.
 */
export function defaultDispositionForVendor(
  vendorClassification: "INVENTORY" | "NON_INVENTORY" | null | undefined,
  aiProposal: "INVENTORY" | "NON_INVENTORY" | null | undefined
): "INVENTORY" | "NON_INVENTORY" {
  if (vendorClassification === "NON_INVENTORY") return "NON_INVENTORY";
  return aiProposal ?? "INVENTORY";
}
