import { signedLineAmount, type LineTreatment } from "@/app/lib/purchaseDocuments/lineTreatment";

/**
 * Totals reconciliation across every line type (client-safe, pure). Never
 * a posting decision -- it explains whether the classified lines add up to
 * the invoice's printed total, and by how much they differ. Amounts are
 * summed in cents to avoid floating drift (the database keeps NUMERIC;
 * this is display-only arithmetic).
 */
export interface ReconciliationLine {
  treatment: LineTreatment;
  lineTotal: number | null;
}

export interface TotalsReconciliation {
  merchandiseSubtotal: number;
  expensesAndFees: number;
  tax: number;
  discounts: number;
  credits: number;
  unresolved: number;
  computedTotal: number;
  headerTotal: number | null;
  /** computedTotal - headerTotal, null when the header has no total. */
  difference: number | null;
  reconciles: boolean | null;
  /** True when the invoice's own tax header is used because no TAX line
   * exists -- so the computed total still includes the printed tax. */
  usedHeaderTax: boolean;
  usedHeaderFees: boolean;
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;

export function reconcileTotals(lines: ReconciliationLine[], header: { tax: number | null; fees: number | null; total: number | null }): TotalsReconciliation {
  let merchandise = 0, expenses = 0, tax = 0, discounts = 0, credits = 0, unresolved = 0;
  let sawTaxLine = false, sawFeeLine = false;
  for (const line of lines) {
    const signed = signedLineAmount(line.treatment, line.lineTotal);
    if (signed === null) continue;
    const c = cents(signed);
    switch (line.treatment) {
      case "INVENTORY_PURCHASE": merchandise += c; break;
      case "EXPENSE": expenses += c; break;
      case "FREIGHT_FEE": expenses += c; sawFeeLine = true; break;
      case "TAX": tax += c; sawTaxLine = true; break;
      case "DISCOUNT": discounts += c; break;
      case "CREDIT_RETURN": credits += c; break;
      case "UNRESOLVED": unresolved += c; break;
    }
  }
  // When the extractor put tax/fees only in the header (no line for them),
  // the header figure is what reconciles the printed total.
  const usedHeaderTax = !sawTaxLine && header.tax !== null && header.tax !== 0;
  const usedHeaderFees = !sawFeeLine && header.fees !== null && header.fees !== 0;
  if (usedHeaderTax) tax += cents(header.tax as number);
  if (usedHeaderFees) expenses += cents(header.fees as number);

  const computed = merchandise + expenses + tax + discounts + credits + unresolved;
  const headerTotal = header.total;
  const difference = headerTotal === null ? null : dollars(computed - cents(headerTotal));
  return {
    merchandiseSubtotal: dollars(merchandise),
    expensesAndFees: dollars(expenses),
    tax: dollars(tax),
    discounts: dollars(discounts),
    credits: dollars(credits),
    unresolved: dollars(unresolved),
    computedTotal: dollars(computed),
    headerTotal,
    difference,
    reconciles: difference === null ? null : Math.abs(difference) < 0.005,
    usedHeaderTax,
    usedHeaderFees,
  };
}
