export type PriceChangeDirection = "increase" | "decrease" | "unchanged";

export interface PriceChangeTone {
  glyph: "↑" | "↓" | "≈";
  colorClass: string;
}

/**
 * Purchase Price Change Intelligence bug fix (Section 10/11/12) -- color
 * directly encodes purchasing direction: a cost INCREASE is red, a cost
 * DECREASE is green, effectively unchanged (comparePrices' own tolerance-
 * widened classification, never a UI-only rounding decision) is muted
 * neutral gray, never colored as a real swing. Always paired with a
 * glyph (↑/↓/≈) so the signal never depends on color alone (Section 11).
 * Shared by the Receiving inline indicator and the Purchasing Report's
 * Price Changes table -- one presentation rule, never two color schemes
 * drifting apart (Section 14's "do not duplicate... in React components").
 */
export function priceChangeTone(direction: PriceChangeDirection): PriceChangeTone {
  if (direction === "increase") return { glyph: "↑", colorClass: "text-red-400" };
  if (direction === "decrease") return { glyph: "↓", colorClass: "text-emerald-400" };
  return { glyph: "≈", colorClass: "text-zinc-500" };
}
