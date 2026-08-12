/**
 * Dedicated to this task only -- never a shared/generic prompt string.
 * Classification, translation, and item-matching are separate future task
 * modules with their own instructions, not options this one should try to
 * also handle.
 */
export const INVOICE_EXTRACTION_INSTRUCTIONS = `You are extracting structured data from a food-service vendor invoice, receipt, or credit memo. These documents may be phone photos, scanned images, or digital PDFs, and may come from any vendor (produce, meat, dairy, dry goods, paper/chemical suppliers, etc.).

Read the entire document before producing your answer.

General rules:
- Preserve the vendor's own terminology. Do not rewrite, standardize, or clean up product names -- copy them as printed.
- Preserve vendor SKU/item codes exactly as printed when visible.
- Preserve the original language of the document. Do not translate anything. Translation is a separate future task, not part of extraction.
- Do not map any line to a canonical/internal product name or category. Item matching is a separate future task -- extraction only records what the document itself says.
- If a value is not present on the document, or you cannot read it reliably, return null for it. Never invent or guess a value to fill a field.
- Do not calculate a value merely because it seems mathematically inferable from other fields (e.g. do not compute a missing line total from quantity and price) unless the document itself states that value. Leave it null instead.

Line items -- this is the most important and most commonly mishandled part:
- A single line may state BOTH a package count (e.g. "5 CS", "2 BOX") AND a separately measured or "catch" weight/quantity (e.g. "90.4 LB"). These are two independent facts. NEVER collapse them into one number, and never treat one as derived from the other.
  Example: "5 CS   87.4 LB   $1.49 LB   $130.23" means packageQuantity=5, packageUnit="CS", measuredQuantity=87.4, measuredUnit="LB", unitPrice=1.49, priceBasisUnit="LB", lineTotal=130.23.
- Some lines only have a fixed package price with no separate measured weight.
  Example: "2 BOX   $37.00 BOX   $74.00" means packageQuantity=2, packageUnit="BOX", measuredQuantity=null, measuredUnit=null, unitPrice=37.00, priceBasisUnit="BOX", lineTotal=74.00.
- These two examples illustrate the pattern -- do not assume every invoice looks exactly like them. Read what is actually printed on each line.
- Distinguish the per-unit price from the line's total price. They are different numbers.
- Preserve the price's basis unit exactly as it determines what the price is quoted per (e.g. "/LB", "/EA", "/CS", "/DZ") -- this may match the package unit, the measured unit, or neither.

Header fields: extract vendor name/address/phone, invoice number, invoice date, delivery date, purchase order number, subtotal, tax, other fees/charges, total, and currency exactly as printed. If the document is a receipt or credit memo rather than a true invoice, set documentType accordingly.

If anything about the document is ambiguous, low-quality, or you are genuinely uncertain about a specific value, note it in the warnings array rather than silently guessing.`;
