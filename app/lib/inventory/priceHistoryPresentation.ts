/**
 * Pure presentation helpers for the Price History tab -- period
 * resolution, package-conversion labels, unavailable-reason copy, and
 * the hand-rolled SVG chart's geometry. No imports from server-only
 * modules so the unit suite (npm test) can exercise every branch
 * directly. Historical purchase pricing only -- nothing here computes
 * or labels an inventory valuation.
 */

export type PriceHistoryPeriod = "30d" | "90d" | "1y" | "all";

export const PRICE_HISTORY_PERIODS: { key: PriceHistoryPeriod; label: string }[] = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "All" },
];

export function priceHistoryPeriodFromParam(value: string | undefined | null): PriceHistoryPeriod {
  if (value === "30d" || value === "1y" || value === "all") return value;
  return "90d";
}

/** Inclusive start date (YYYY-MM-DD, matching purchase document_date's
 * date type) for a period ending at `now`; null means unbounded. */
export function periodStartDate(period: PriceHistoryPeriod, now: Date): string | null {
  if (period === "all") return null;
  const days = period === "30d" ? 30 : period === "90d" ? 90 : 365;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}

/** "1 CASE = 24 PIECE" when a fixed vendor-package snapshot exists;
 * falls back to the invoice's own package unit, then the base unit --
 * never a guessed conversion. */
export function conversionLabel(input: {
  snapshotPurchaseUnitCode: string | null;
  snapshotConversionFactor: number | null;
  packageUnit: string | null;
  baseUnitCode: string;
}): string {
  if (input.snapshotPurchaseUnitCode && input.snapshotConversionFactor !== null && Number.isFinite(input.snapshotConversionFactor)) {
    return `1 ${input.snapshotPurchaseUnitCode} = ${formatFactor(input.snapshotConversionFactor)} ${input.baseUnitCode}`;
  }
  if (input.packageUnit) return input.packageUnit;
  return input.baseUnitCode;
}

function formatFactor(factor: number): string {
  return Number.isInteger(factor) ? String(factor) : String(Number(factor.toFixed(4)));
}

export interface PriceChange {
  dollarChange: number;
  percentChange: number | null;
}

/** Change from `previous` to `current`. Percent is null when the
 * previous price is zero/invalid (never Infinity/NaN); the whole result
 * is null when either input is missing -- callers must omit the change
 * line entirely rather than fabricate one. */
export function computePriceChange(current: number | null, previous: number | null): PriceChange | null {
  if (current === null || previous === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const dollarChange = current - previous;
  const percentChange = previous > 0 && Number.isFinite(dollarChange / previous) ? (dollarChange / previous) * 100 : null;
  return { dollarChange, percentChange };
}

export function priceUnavailableCopy(reason: string | null): string {
  switch (reason) {
    case "MISSING_LINE_AMOUNT":
      return "Price unavailable — no line amount was captured for this purchase.";
    case "NON_POSITIVE_LINE_AMOUNT":
      return "Price unavailable — the line amount is zero or a credit.";
    case "NON_POSITIVE_QUANTITY":
      return "Price unavailable — no positive inventory quantity was posted.";
    case "QUANTITY_MISMATCH":
      return "Price unavailable — the received quantity differs from the invoiced quantity.";
    default:
      return "Price unavailable.";
  }
}

// ============================================================
// Chart geometry
// ============================================================

export interface ChartPointInput {
  /** Stable identity for React keys/tooltips. */
  id: string;
  receivedAt: string;
  vendorId: string | null;
  price: number;
  corrected: boolean;
}

export interface ChartPoint extends ChartPointInput {
  x: number;
  y: number;
  colorIndex: number;
}

export interface ChartSeries {
  vendorId: string | null;
  colorIndex: number;
  points: ChartPoint[];
}

export interface ChartGeometry {
  series: ChartSeries[];
  /** Y-axis tick values (prices), lowest first. */
  yTicks: number[];
  priceMin: number;
  priceMax: number;
}

/** Fixed, deliberately-small vendor palette -- assignment order is by
 * first (oldest) appearance so colors stay stable as pages load. */
export const VENDOR_COLOR_CLASSES = [
  { stroke: "stroke-amber-400", fill: "fill-amber-400", text: "text-amber-400", bg: "bg-amber-400" },
  { stroke: "stroke-sky-400", fill: "fill-sky-400", text: "text-sky-400", bg: "bg-sky-400" },
  { stroke: "stroke-emerald-400", fill: "fill-emerald-400", text: "text-emerald-400", bg: "bg-emerald-400" },
  { stroke: "stroke-fuchsia-400", fill: "fill-fuchsia-400", text: "text-fuchsia-400", bg: "bg-fuchsia-400" },
  { stroke: "stroke-orange-400", fill: "fill-orange-400", text: "text-orange-400", bg: "bg-orange-400" },
  { stroke: "stroke-violet-400", fill: "fill-violet-400", text: "text-violet-400", bg: "bg-violet-400" },
];

/**
 * Scales priced events into unit-square coordinates (x, y in [0, 1],
 * y = 0 at the TOP like SVG) and splits them into one series per
 * vendor -- the renderer draws connecting segments only WITHIN a
 * series, so different vendors are never joined as one trend. Never
 * fabricates zero points: only the events passed in are plotted, and
 * the y-domain is padded around the real min/max (a flat/single-point
 * history centers rather than collapsing).
 */
export function computeChartGeometry(points: ChartPointInput[]): ChartGeometry | null {
  const valid = points.filter((p) => Number.isFinite(p.price));
  if (valid.length === 0) return null;

  const times = valid.map((p) => new Date(p.receivedAt).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin;

  const prices = valid.map((p) => p.price);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  // Pad 10% of the span (or 10% of the value when flat) so extremes
  // never sit on the chart edge and a single point renders mid-chart.
  const pad = pMax - pMin > 0 ? (pMax - pMin) * 0.1 : Math.max(pMax * 0.1, 0.01);
  const domainMin = pMin - pad;
  const domainMax = pMax + pad;

  const colorByVendor = new Map<string, number>();
  const sortedOldestFirst = [...valid].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  for (const p of sortedOldestFirst) {
    const key = p.vendorId ?? "unknown";
    if (!colorByVendor.has(key)) colorByVendor.set(key, colorByVendor.size % VENDOR_COLOR_CLASSES.length);
  }

  const seriesByVendor = new Map<string, ChartSeries>();
  for (const p of sortedOldestFirst) {
    const key = p.vendorId ?? "unknown";
    const colorIndex = colorByVendor.get(key) ?? 0;
    const point: ChartPoint = {
      ...p,
      x: tSpan > 0 ? (new Date(p.receivedAt).getTime() - tMin) / tSpan : 0.5,
      y: 1 - (p.price - domainMin) / (domainMax - domainMin),
      colorIndex,
    };
    const series = seriesByVendor.get(key);
    if (series) series.points.push(point);
    else seriesByVendor.set(key, { vendorId: p.vendorId, colorIndex, points: [point] });
  }

  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount }, (_, i) => domainMin + ((domainMax - domainMin) * i) / (tickCount - 1));

  return { series: [...seriesByVendor.values()], yTicks, priceMin: pMin, priceMax: pMax };
}
