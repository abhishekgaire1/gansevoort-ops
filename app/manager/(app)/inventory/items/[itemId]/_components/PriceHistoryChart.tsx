"use client";

import { useState } from "react";
import type { PriceHistoryEvent } from "@/app/lib/inventory/priceHistory";
import { computeChartGeometry, VENDOR_COLOR_CLASSES, conversionLabel, type ChartPoint } from "@/app/lib/inventory/priceHistoryPresentation";
import { formatMoney } from "@/app/lib/formatMoney";
import { formatQuantityMagnitude } from "../../../_lib/activityPresentation";

/**
 * Hand-rolled inline SVG price chart (deliberate decision: no chart
 * library exists in this project and none is added for this feature) --
 * vendor-colored points with connecting segments drawn only WITHIN one
 * vendor's series, never across vendors, so two suppliers are never
 * presented as one continuous trend. Only real priced events are
 * plotted: no fabricated zero points, no interpolation of missing
 * purchases. The table below the chart is the authoritative record;
 * this is a visual summary of the SAME rows.
 */

const VIEW_W = 720;
const VIEW_H = 220;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 28;

export function PriceHistoryChart({ events, currency }: { events: PriceHistoryEvent[]; currency: string }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const priced = events.filter((e) => e.normalizedPrice !== null && e.currency === currency);
  const geometry = computeChartGeometry(
    priced.map((e) => ({
      id: `${e.purchaseDocumentId}:${e.lineKey}`,
      receivedAt: e.receivedAt,
      vendorId: e.vendorId,
      price: e.normalizedPrice as number,
      corrected: e.hasCorrection,
    }))
  );
  if (!geometry) {
    return <p className="px-4 py-6 text-sm text-zinc-500">No priced purchases to chart for this selection.</p>;
  }

  const eventById = new Map(priced.map((e) => [`${e.purchaseDocumentId}:${e.lineKey}`, e]));
  const hoveredPoint = geometry.series.flatMap((s) => s.points).find((p) => p.id === hovered) ?? null;
  const hoveredEvent = hoveredPoint ? (eventById.get(hoveredPoint.id) ?? null) : null;

  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = VIEW_H - PAD_T - PAD_B;
  const px = (p: ChartPoint) => PAD_L + p.x * plotW;
  const py = (p: ChartPoint) => PAD_T + p.y * plotH;

  const allPoints = geometry.series.flatMap((s) => s.points);
  const xLabels = xAxisLabels(allPoints);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="w-full" role="img" aria-label="Normalized purchase price over time, one series per vendor">
        {geometry.yTicks.map((tick, i) => {
          const y = PAD_T + plotH - (plotH * i) / (geometry.yTicks.length - 1);
          return (
            <g key={i}>
              <line x1={PAD_L} x2={VIEW_W - PAD_R} y1={y} y2={y} className="stroke-zinc-800" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="fill-zinc-500 text-[10px]">
                {formatMoney(tick, currency)}
              </text>
            </g>
          );
        })}
        {xLabels.map((label, i) => (
          <text key={i} x={PAD_L + label.x * plotW} y={VIEW_H - 8} textAnchor="middle" className="fill-zinc-500 text-[10px]">
            {label.text}
          </text>
        ))}
        {geometry.series.map((series) => {
          const color = VENDOR_COLOR_CLASSES[series.colorIndex];
          return (
            <g key={series.vendorId ?? "unknown"}>
              {series.points.length > 1 ? (
                <polyline
                  points={series.points.map((p) => `${px(p)},${py(p)}`).join(" ")}
                  fill="none"
                  strokeWidth={1.5}
                  className={`${color.stroke} opacity-60`}
                />
              ) : null}
              {series.points.map((p) => (
                <g key={p.id}>
                  {p.corrected ? <circle cx={px(p)} cy={py(p)} r={7} fill="none" strokeWidth={1.5} className="stroke-amber-400" /> : null}
                  <circle
                    cx={px(p)}
                    cy={py(p)}
                    r={hovered === p.id ? 5 : 3.5}
                    className={`${color.fill} cursor-pointer`}
                    onMouseEnter={() => setHovered(p.id)}
                    onMouseLeave={() => setHovered(null)}
                  />
                </g>
              ))}
            </g>
          );
        })}
      </svg>

      {hoveredPoint && hoveredEvent ? (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-lg border border-zinc-700 bg-zinc-950/95 p-2.5 text-xs shadow-lg"
          style={{
            left: `min(max(${((PAD_L + hoveredPoint.x * plotW) / VIEW_W) * 100}% - 7rem, 0.25rem), calc(100% - 14.25rem))`,
            top: `${((PAD_T + hoveredPoint.y * plotH) / VIEW_H) * 100}%`,
          }}
        >
          <p className={`font-medium ${VENDOR_COLOR_CLASSES[hoveredPoint.colorIndex].text}`}>{hoveredEvent.vendorName ?? "Unknown vendor"}</p>
          <p className="mt-0.5 text-zinc-400">
            {new Date(hoveredEvent.receivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            {hoveredEvent.documentNumber ? ` · Invoice #${hoveredEvent.documentNumber}` : ""}
          </p>
          <p className="text-zinc-400">{conversionLabel(hoveredEvent)}</p>
          <p className="mt-0.5 font-semibold text-zinc-100">
            {formatMoney(hoveredEvent.normalizedPrice, hoveredEvent.currency)} / {hoveredEvent.baseUnitCode}
          </p>
          <p className="text-zinc-400">
            Received {formatQuantityMagnitude(hoveredEvent.authoritativeQuantity)} {hoveredEvent.baseUnitCode}
            {hoveredEvent.hasCorrection ? <span className="ml-1 text-amber-400">· Corrected</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function xAxisLabels(points: ChartPoint[]): { x: number; text: string }[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const fmt = (p: ChartPoint) => new Date(p.receivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (last.x - first.x < 0.15) return [{ x: (first.x + last.x) / 2, text: fmt(last) }];
  const mid = sorted[Math.floor(sorted.length / 2)];
  const labels = [{ x: first.x, text: fmt(first) }];
  if (mid !== first && mid !== last && mid.x - first.x > 0.15 && last.x - mid.x > 0.15) labels.push({ x: mid.x, text: fmt(mid) });
  labels.push({ x: last.x, text: fmt(last) });
  return labels;
}
