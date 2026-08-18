/**
 * The single shared currency-formatting helper for manager-facing UI --
 * every purchase-document/receiving screen previously had its own
 * near-identical `money()` copy, several of which had the same bug: a
 * 3-letter ISO currency code (e.g. "USD") was treated as if it were
 * already a display symbol and printed verbatim ("USD4.49" instead of
 * "$4.49"), since `currency.length <= 3` is true for "USD" itself.
 *
 * Uses Intl.NumberFormat rather than a hardcoded "$" so a genuinely
 * different stored currency (e.g. "EUR", "CAD") renders with its own
 * correct symbol/format instead of a hardcoded dollar sign -- for the
 * current Gansevoort organization, whose documents are always USD, this
 * simply prints "$4.49" as expected. This is presentation-only: it never
 * reads, writes, or normalizes the stored currency value itself.
 */
const DEFAULT_CURRENCY = "USD";
const ISO_4217_CODE = /^[A-Za-z]{3}$/;

export function formatMoney(value: number | null, currencyCode?: string | null): string {
  if (value === null) return "—";

  const code = currencyCode && ISO_4217_CODE.test(currencyCode) ? currencyCode.toUpperCase() : DEFAULT_CURRENCY;

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(value);
  } catch {
    // An unrecognized/invalid ISO code (e.g. AI-extraction noise) --
    // never let a formatting failure hide the underlying number.
    return new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_CURRENCY }).format(value);
  }
}
