/**
 * Purchase-package mismatch surfaced during the four-step review (not only
 * at posting time). Pure, framework-free logic -- same "no jsdom, extract
 * to a pure function" convention as newItemVerification.ts/
 * simplifiedVerificationView.ts -- so this is directly unit-testable.
 *
 * Mirrors the SAME comparison post_purchase_document_inventory
 * (20260811100123) already performs authoritatively at posting time:
 * `u.id <> coalesce(vpu.purchase_unit_id, ii.base_unit_id)`. Both sides
 * here are already-RESOLVED unit codes (matched against the real units
 * table server-side, never raw free text) -- when either side can't be
 * confidently resolved, this deliberately reports no mismatch rather than
 * guessing (a genuinely unrecognized unit is a different, pre-existing
 * concern the posting RPC's own blocker scan still separately catches).
 */

export interface PackageUnitMismatchInput {
  status: "PENDING_REVIEW" | "CONFIRMED" | "STALE" | "UNCLASSIFIED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  /** The invoice-extracted unit, resolved against the real units table
   * (case/whitespace-insensitive) -- null when unresolved/unrecognized,
   * never raw free text. */
  resolvedInvoiceUnitCode: string | null;
  /** The confirmed vendor/SKU purchase package's unit code, or the item's
   * base unit code when the classification has no vendor package
   * (SAME_UNIT) -- exactly coalesce(vpu.purchase_unit_id, ii.base_unit_id). */
  effectivePurchaseUnitCode: string | null;
}

/** Expense (NON_INVENTORY) lines, and lines not yet CONFIRMED, are never
 * blocked by this check -- there is no confirmed purchase package to
 * compare against yet, and expense lines never post inventory at all. */
export function hasPackageUnitMismatch(input: PackageUnitMismatchInput): boolean {
  if (input.status !== "CONFIRMED" || input.disposition !== "INVENTORY") return false;
  if (!input.resolvedInvoiceUnitCode || !input.effectivePurchaseUnitCode) return false;
  return input.resolvedInvoiceUnitCode.trim().toUpperCase() !== input.effectivePurchaseUnitCode.trim().toUpperCase();
}

/** Resolves the raw invoice-extracted packageUnit TEXT against the real,
 * recognized unit codes -- never a raw string compare against unverified
 * OCR text. Returns null (never guesses) when the text doesn't match any
 * recognized unit. */
export function resolveUnitCode(rawText: string | null, recognizedUnitCodes: ReadonlySet<string>): string | null {
  if (!rawText) return null;
  const normalized = rawText.trim().toUpperCase();
  return recognizedUnitCodes.has(normalized) ? normalized : null;
}

export interface LineMismatchResolutionInput {
  status: "PENDING_REVIEW" | "CONFIRMED" | "STALE";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  /** The raw invoice-extracted packageUnit text for this line. */
  invoicePackageUnitText: string | null;
  /** This classification's own resolved vendor/SKU purchase package, or
   * null when there is none (SAME_UNIT) -- never the shared/global
   * inventory_item_units row (see getReceivingLines.ts's own doc comment
   * for the exact bug this guards against: a second vendor/SKU's approval
   * silently repricing an unrelated line). */
  vendorPackage: {
    unitCode: string | null;
    unitName: string | null;
    receivingBehavior: "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";
    conversionFactor: number | null;
  } | null;
  /** The item's own base unit -- the SAME_UNIT fallback, exactly
   * coalesce(vpu.purchase_unit_id, ii.base_unit_id). */
  itemBaseUnit: { code: string | null; name: string | null } | null;
  recognizedUnitCodes: ReadonlySet<string>;
}

export interface LineMismatchResolution {
  effectivePurchaseUnitCode: string | null;
  effectivePurchaseUnitName: string | null;
  effectiveReceivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  effectiveConversionFactor: number | null;
  resolvedInvoiceUnitCode: string | null;
  hasPackageMismatch: boolean;
}

/** The single shared resolver behind getPurchaseDocumentLineClassifications'
 * per-line purchase-package-mismatch fields -- pure (no Supabase calls of
 * its own) so it's directly unit-testable, and reusable from a DB-backed
 * test that fetches real classification/vendor-package rows and pipes
 * them through the exact same logic production uses. */
export function resolveLineMismatchFields(input: LineMismatchResolutionInput): LineMismatchResolution {
  const effectivePurchaseUnitCode = input.vendorPackage?.unitCode ?? input.itemBaseUnit?.code ?? null;
  const effectivePurchaseUnitName = input.vendorPackage?.unitName ?? input.itemBaseUnit?.name ?? null;
  const effectiveReceivingBehavior: LineMismatchResolution["effectiveReceivingBehavior"] = input.vendorPackage ? input.vendorPackage.receivingBehavior : "SAME_UNIT";
  const effectiveConversionFactor = input.vendorPackage && effectiveReceivingBehavior === "FIXED_CONVERSION" ? input.vendorPackage.conversionFactor : null;
  const resolvedInvoiceUnitCode = resolveUnitCode(input.invoicePackageUnitText, input.recognizedUnitCodes);
  const hasPackageMismatch = hasPackageUnitMismatch({ status: input.status, disposition: input.disposition, resolvedInvoiceUnitCode, effectivePurchaseUnitCode });
  return { effectivePurchaseUnitCode, effectivePurchaseUnitName, effectiveReceivingBehavior, effectiveConversionFactor, resolvedInvoiceUnitCode, hasPackageMismatch };
}

export interface PackageConfirmationInput {
  packageQuantity: number | null;
  /** Prefer the invoice's own resolved unit text; when the raw invoice
   * text isn't available/recognized (common for a historical line whose
   * package_unit was never extracted), the confirmed purchase unit itself
   * is shown instead -- still an honest statement of "the unit this line
   * is being treated as," never a fabricated invoice fact. */
  resolvedInvoiceUnitCode: string | null;
  effectivePurchaseUnitCode: string | null;
  effectiveReceivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  effectiveConversionFactor: number | null;
  inventoryBaseUnitCode: string | null;
}

export interface PackageConfirmationDisplay {
  /** "inline" -- a single short line, shown after the "Purchase package
   * confirmed:" heading on the SAME line (the direct one-to-one case).
   * "block" -- a heading followed by each of `lines` on its own line
   * (fixed-conversion and measured-at-receiving cases). */
  mode: "inline" | "block";
  lines: string[];
}

/** The calm, positive Step 2 confirmation for a CONFIRMED inventory line
 * whose purchase package is genuinely resolved and does NOT mismatch (see
 * hasPackageUnitMismatch -- callers must check that separately and show
 * the red warning instead when it's true). Returns null when there is
 * nothing confirmed yet to show (no effective purchase unit resolved at
 * all) -- never fabricates a conversion that was never actually
 * confirmed. */
export function formatPackageConfirmation(input: PackageConfirmationInput): PackageConfirmationDisplay | null {
  const { packageQuantity, effectivePurchaseUnitCode, effectiveReceivingBehavior, effectiveConversionFactor, inventoryBaseUnitCode } = input;
  if (!effectivePurchaseUnitCode || !effectiveReceivingBehavior) return null;
  const invoiceUnit = input.resolvedInvoiceUnitCode ?? effectivePurchaseUnitCode;
  const qty = packageQuantity ?? null;
  const invoiceLine = `Invoice: ${qty !== null ? `${qty} ` : ""}${invoiceUnit}`;

  if (effectiveReceivingBehavior === "MEASURE_EACH_DELIVERY" || effectiveReceivingBehavior === "COUNT_EACH_DELIVERY") {
    const behaviorLabel = effectiveReceivingBehavior === "MEASURE_EACH_DELIVERY" ? "weight or volume is measured" : "count is verified";
    return { mode: "block", lines: [invoiceLine, `${effectivePurchaseUnitCode} -- ${behaviorLabel} each delivery (no fixed conversion)`] };
  }

  if (effectiveReceivingBehavior === "FIXED_CONVERSION") {
    if (!effectiveConversionFactor || !inventoryBaseUnitCode) return null;
    const lines = [invoiceLine, `Conversion: 1 ${effectivePurchaseUnitCode} = ${effectiveConversionFactor} ${inventoryBaseUnitCode}`];
    if (qty !== null) lines.push(`Inventory received: ${qty * effectiveConversionFactor} ${inventoryBaseUnitCode}`);
    return { mode: "block", lines };
  }

  // SAME_UNIT -- direct one-to-one, e.g. "3 BOTTLE → 3 BOTTLE".
  return { mode: "inline", lines: [qty !== null ? `${qty} ${effectivePurchaseUnitCode} → ${qty} ${effectivePurchaseUnitCode}` : `${effectivePurchaseUnitCode} → ${effectivePurchaseUnitCode}`] };
}
