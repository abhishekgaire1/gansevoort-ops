/**
 * Adaptive USD formatting, shared by AI Usage & Cost and Manager Expense
 * Categories. Individual AI requests may cost a fraction of a cent; a flat
 * 2-decimal format would silently round those to "$0.00", so sub-cent
 * values get extra precision. Aggregates (including expense-category
 * totals) use plain 2-decimal formatting once they're a cent or more.
 */
export function formatEstimatedCost(valueUsd: number): string {
  if (valueUsd === 0) return "$0.00";
  const abs = Math.abs(valueUsd);
  if (abs >= 0.01) return `$${valueUsd.toFixed(2)}`;

  // Sub-cent: 4 decimals matches the milestone's own examples ($0.0038,
  // $0.0042) -- extend further only if that would otherwise still round
  // to zero (an extremely small fractional-cent value).
  for (let decimals = 4; decimals <= 6; decimals++) {
    const rounded = valueUsd.toFixed(decimals);
    if (Number(rounded) !== 0) return `$${rounded}`;
  }
  return `$${valueUsd.toFixed(6)}`;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
