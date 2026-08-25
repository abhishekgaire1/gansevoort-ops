import { describe, expect, it, vi } from "vitest";
import { fetchReportExport } from "@/app/manager/(app)/reports/_lib/reportDownload";
import { buildExportQueryString } from "@/app/manager/(app)/reports/_lib/exportQueryString";
import type { ResolvedReportPeriod } from "@/app/manager/(app)/reports/_lib/reportPeriod";

// CI-safe: pure functions with a stubbed fetch -- no real network call.

describe("15. fetchReportExport -- a failed export reports failure, it never throws", () => {
  it("returns ok:false on a non-OK HTTP response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const result = await fetchReportExport("purchasing", "xlsx", "period=30D", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false });
  });

  it("returns ok:false if fetch itself rejects (network error) -- never throws upward", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await fetchReportExport("purchasing", "xlsx", "period=30D", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false });
  });

  it("returns the blob and filename on success", async () => {
    const blob = new Blob(["data"]);
    const fetchImpl = vi.fn(async () => new Response(blob, { status: 200, headers: { "Content-Disposition": 'attachment; filename="purchasing_2026-08-01_to_2026-08-24.xlsx"' } }));
    const result = await fetchReportExport("purchasing", "xlsx", "period=30D", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe("purchasing_2026-08-01_to_2026-08-24.xlsx");
  });

  it("requests the exact report/format/query-string combination given", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob([]), { status: 200 }));
    await fetchReportExport("waste", "csv", "period=7D&location=loc1", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/manager/reports/export?report=waste&format=csv&period=7D&location=loc1", { method: "GET" });
  });
});

describe("2/3/4. buildExportQueryString preserves the exact period/filters currently on screen", () => {
  const period30d: ResolvedReportPeriod = { key: "30D", startDate: "2026-07-25", endDate: "2026-08-24", customError: null };
  const periodCustom: ResolvedReportPeriod = { key: "CUSTOM", startDate: "2026-08-01", endDate: "2026-08-10", customError: null };

  it("includes the period key for a rolling period, with no from/to", () => {
    const qs = buildExportQueryString(period30d);
    expect(qs).toBe("period=30D");
  });

  it("includes explicit from/to for a CUSTOM period", () => {
    const qs = buildExportQueryString(periodCustom);
    expect(new URLSearchParams(qs).get("from")).toBe("2026-08-01");
    expect(new URLSearchParams(qs).get("to")).toBe("2026-08-10");
  });

  it("forwards extra filters (vendor/category/location) only when present", () => {
    const qs = buildExportQueryString(period30d, { vendor: "v1", category: null, location: undefined });
    const params = new URLSearchParams(qs);
    expect(params.get("vendor")).toBe("v1");
    expect(params.has("category")).toBe(false);
    expect(params.has("location")).toBe(false);
  });
});
