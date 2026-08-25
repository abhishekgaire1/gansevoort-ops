import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";

// CI-safe: auth, service client, timezone resolution, and every report
// lib function are mocked -- no network, no database, no real Supabase
// Auth traffic. The xlsx/csv/pdf writers run for real (pure, already
// covered by tests/reportExportWriters.unit.test.ts) so this file
// exercises the actual end-to-end Route Handler wiring.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({
  requireManagerOrAdmin: requireManagerOrAdminMock,
  AuthInfrastructureError: class AuthInfrastructureError extends Error {},
}));

const { getServiceRoleClientMock, fromMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(), fromMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

vi.mock("@/app/lib/dateRanges/organizationTimezone", () => ({ resolveOrganizationTimezone: vi.fn(async () => "America/New_York") }));

const { getPurchasingReportMock, getPurchasingReportPriceChangesMock } = vi.hoisted(() => ({
  getPurchasingReportMock: vi.fn(),
  getPurchasingReportPriceChangesMock: vi.fn(),
}));
vi.mock("@/app/lib/reports/purchasingReport", () => ({
  getPurchasingReport: getPurchasingReportMock,
  getPurchasingReportPriceChanges: getPurchasingReportPriceChangesMock,
}));

const { getUsageReportMock } = vi.hoisted(() => ({ getUsageReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/usageReport", () => ({ getUsageReport: getUsageReportMock }));

const { getWasteReportMock } = vi.hoisted(() => ({ getWasteReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/wasteReport", () => ({ getWasteReport: getWasteReportMock }));

const { getReceivingReportMock } = vi.hoisted(() => ({ getReceivingReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/receivingReport", () => ({ getReceivingReport: getReceivingReportMock }));

const { getInventoryStatusReportMock } = vi.hoisted(() => ({ getInventoryStatusReportMock: vi.fn() }));
vi.mock("@/app/lib/reports/inventoryStatusReport", () => ({ getInventoryStatusReport: getInventoryStatusReportMock }));

import { GET } from "@/app/manager/(app)/reports/export/route";

const ORG_ID = "org-1";

const EMPTY_PURCHASING = { totalPurchaseValue: 0, documentCount: 0, vendorCount: 0, itemCount: 0, byVendor: [], byCategory: [], byItem: [] };
const EMPTY_PRICE_CHANGES = { increases: [], decreases: [] };
const EMPTY_USAGE = { movementCount: 0, byItem: [], byStation: [] };
const EMPTY_WASTE = { eventCount: 0, byItem: [], byReason: [] };
const EMPTY_RECEIVING = { documentCount: 0, byStatus: [], byVendor: [], creditLineCount: 0, readyToPostCount: 0, partiallyPostedCount: 0, postedCount: 0 };
const EMPTY_INVENTORY_STATUS = { lowStockCount: 0, outOfStockCount: 0, healthyCount: 0, rows: [] };

function fakeServiceClient(nameByTable: Record<string, string | null>) {
  return {
    from: fromMock.mockImplementation((table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: nameByTable[table] ? { name: nameByTable[table] } : null, error: null }),
          }),
        }),
      }),
    })),
  };
}

function requestFor(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://example.com"));
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset();
  getServiceRoleClientMock.mockReset();
  fromMock.mockReset();
  getPurchasingReportMock.mockReset().mockResolvedValue(EMPTY_PURCHASING);
  getPurchasingReportPriceChangesMock.mockReset().mockResolvedValue(EMPTY_PRICE_CHANGES);
  getUsageReportMock.mockReset().mockResolvedValue(EMPTY_USAGE);
  getWasteReportMock.mockReset().mockResolvedValue(EMPTY_WASTE);
  getReceivingReportMock.mockReset().mockResolvedValue(EMPTY_RECEIVING);
  getInventoryStatusReportMock.mockReset().mockResolvedValue(EMPTY_INVENTORY_STATUS);
  getServiceRoleClientMock.mockReturnValue(fakeServiceClient({}));
  requireManagerOrAdminMock.mockResolvedValue({ ok: true, manager: { appUserId: "u1", organizationId: ORG_ID, authUserId: "au1", roles: ["manager"] } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("export Route Handler", () => {
  it("1. auth required -- an unauthenticated caller is rejected before any report data is fetched", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx"));
    expect(response.status).toBe(401);
    expect(getPurchasingReportMock).not.toHaveBeenCalled();
  });

  it("1. an authenticated but non-manager/admin caller is rejected (403)", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authorized" });
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx"));
    expect(response.status).toBe(403);
  });

  it("2/16. organization scope is derived server-side from the authenticated context, never from the query string, and the SAME report lib function every page uses is reused", async () => {
    await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx&organizationId=some-other-org"));
    expect(getPurchasingReportMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.any(String), expect.any(String), expect.anything());
  });

  it("3. date filters (period) are preserved -- the resolved date range is passed through to the report function", async () => {
    await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx&period=CUSTOM&from=2026-08-01&to=2026-08-10"));
    expect(getPurchasingReportMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, "2026-08-01", "2026-08-10", expect.anything());
  });

  it("4. vendor/category filters are preserved and forwarded to the report function", async () => {
    await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx&vendor=v1&category=c1"));
    expect(getPurchasingReportMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.any(String), expect.any(String), { vendorId: "v1", inventoryCategoryId: "c1" });
    expect(getPurchasingReportPriceChangesMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.any(String), expect.any(String), "v1", "c1");
  });

  it("4. the resolved filter label (vendor name) is looked up from the caller's OWN organization scope and appears in the export", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ vendors: "Capital Paper" }));
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx&vendor=v1"));
    const buffer = Buffer.from(await response.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const summaryRows = XLSX.utils.sheet_to_json(workbook.Sheets["Summary"], { header: 1 }) as unknown[][];
    expect(summaryRows.some((row) => row[0] === "Vendor" && row[1] === "Capital Paper")).toBe(true);
  });

  it("4. location filter is preserved for Waste", async () => {
    await GET(requestFor("/manager/reports/export?report=waste&format=csv&location=loc1"));
    expect(getWasteReportMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, expect.any(String), expect.any(String), { locationId: "loc1" });
  });

  it("13. an unsupported report type is rejected with 400, before any auth/report work happens", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=sales&format=xlsx"));
    expect(response.status).toBe(400);
    expect(requireManagerOrAdminMock).not.toHaveBeenCalled();
  });

  it("14. an unsupported export format is rejected with 400", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=docx"));
    expect(response.status).toBe(400);
  });

  it("5. produces a real, readable xlsx workbook", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml");
    const buffer = Buffer.from(await response.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    expect(workbook.SheetNames).toContain("Summary");
  });

  it("6. produces a real, readable csv", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=csv"));
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    const text = await response.text();
    expect(text.split("\r\n")[0]).toBe("Item,Total Value");
  });

  it("7. produces a real pdf", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=pdf"));
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
  });

  it("8. an empty report exports successfully (not an error) -- headers only", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=inventory-status&format=csv"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim().split("\r\n")).toHaveLength(1);
  });

  it("12. sets a sanitized, predictable Content-Disposition filename", async () => {
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx&period=CUSTOM&from=2026-08-01&to=2026-08-24"));
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="purchasing_2026-08-01_to_2026-08-24.xlsx"');
  });

  it("15. a report-fetch failure returns a generic error response, never an unhandled exception", async () => {
    getPurchasingReportMock.mockRejectedValue(new Error("db exploded"));
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe("Could not generate the report. Try again.");
    expect(body.message).not.toContain("db exploded");
  });

  it("9. an infrastructure auth failure never grants access -- generic 503, no report data fetched", async () => {
    const { AuthInfrastructureError } = await import("@/app/lib/auth/managerAuth");
    requireManagerOrAdminMock.mockRejectedValue(new AuthInfrastructureError("rate limited"));
    const response = await GET(requestFor("/manager/reports/export?report=purchasing&format=xlsx"));
    expect(response.status).toBe(503);
    expect(getPurchasingReportMock).not.toHaveBeenCalled();
  });

  it("inventory-status has no date range -- point-in-time, matching the on-screen report", async () => {
    await GET(requestFor("/manager/reports/export?report=inventory-status&format=xlsx&location=loc1"));
    expect(getInventoryStatusReportMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, { locationId: "loc1" });
  });

  it("overview composes the SAME five report functions every other export uses, never a new computation", async () => {
    await GET(requestFor("/manager/reports/export?report=overview&format=xlsx"));
    expect(getPurchasingReportMock).toHaveBeenCalled();
    expect(getReceivingReportMock).toHaveBeenCalled();
    expect(getUsageReportMock).toHaveBeenCalled();
    expect(getWasteReportMock).toHaveBeenCalled();
    expect(getInventoryStatusReportMock).toHaveBeenCalled();
  });
});
