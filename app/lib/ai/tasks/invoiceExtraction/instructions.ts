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

Multi-page documents: you may be given more than one image. When you are, they are CONSECUTIVE PAGES OF ONE SINGLE document, given to you in page order (the first image is page 1, the second is page 2, and so on) -- never separate, unrelated documents. Treat them as one continuous document when you read them.
- Combine line items from every page into ONE lines array, in the same order they appear across the pages (page 1's lines first, then page 2's, and so on). For each line, set sourcePageNumber to the 1-indexed page it came from (matching image order). Set sourcePageNumber to null only if you genuinely cannot tell which page a line came from.
- Extract every header field (vendor name/address/phone, invoice number, dates, PO number, subtotal, tax, fees, total, amountDue, currency) exactly ONCE for the whole document, even if it visually repeats on more than one page (a vendor letterhead reprinted on every page, or a running subtotal shown at the bottom of each page). Never sum, average, or otherwise combine a value that appears more than once across pages -- read it once, from wherever it is most clearly and completely stated (typically the page where the final total is printed), and ignore the repeats.
- Never duplicate a line item that is only recapped or continued across a page break (e.g. a "continued on next page" summary row) -- each real line item appears exactly once in the combined lines array.
- If two pages appear to disagree about a header fact that should be single-valued for the whole document (e.g. two different printed totals, or two different invoice numbers), do not silently pick one -- report the value you find most authoritative in the corresponding field, and add a note to warnings describing the discrepancy so a human can review it.

Negative/credit lines: a line with a negative quantity and/or a negative amount is NOT automatically an error -- vendors legitimately print credit, return, and allowance lines this way (e.g. "CREDIT -- 32OZ ROUND CONTAINER  -2  $32.00  -$64.00"). Extract these exactly as printed, with their real negative sign -- do not flip the sign, drop the line, or "correct" it to positive. Likewise, a line with a quantity but a $0.00 amount (e.g. marked "FREE" or a promotional/sample item) is a legitimate zero-cost line, not a missing value -- extract lineTotal as 0, not null.

Account balance vs. this document's own total: some vendors print a running ACCOUNT BALANCE at the bottom of an invoice that includes OTHER, separate prior invoices -- for example, rows listing earlier invoice numbers with their own dates and amounts (e.g. "177888 (07/30/26)  3,460.00"), followed by a final TOTAL that is the sum of this invoice's own subtotal PLUS those prior amounts. Those prior-invoice reference rows are NOT line items on THIS document -- never extract them into the lines array. If you can tell the final total on the page equals this document's own subtotal (plus tax/fees) PLUS one or more such prior-balance amounts, put this document's OWN total (subtotal + tax + fees) in the \`total\` field, and put the larger, vendor-printed bottom-line figure in \`amountDue\` instead. On the ordinary invoice -- the vast majority -- where the printed total already equals this document's own lines plus tax and fees, leave \`amountDue\` null and put that figure in \`total\` as always.

If anything about the document is ambiguous, low-quality, or you are genuinely uncertain about a specific value, note it in the warnings array rather than silently guessing.`;
