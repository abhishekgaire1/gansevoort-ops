import { NextResponse, type NextRequest } from "next/server";
import { requireManagerOrAdmin, AuthInfrastructureError } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { resolveReportPeriod } from "../_lib/reportPeriod";
import { getPurchasingReport, getPurchasingReportPriceChanges } from "@/app/lib/reports/purchasingReport";
import { getUsageReport } from "@/app/lib/reports/usageReport";
import { getWasteReport } from "@/app/lib/reports/wasteReport";
import { getReceivingReport } from "@/app/lib/reports/receivingReport";
import { getInventoryStatusReport } from "@/app/lib/reports/inventoryStatusReport";
import {
  buildPurchasingExportDocument,
  buildUsageExportDocument,
  buildWasteExportDocument,
  buildReceivingExportDocument,
  buildInventoryStatusExportDocument,
  buildOverviewExportDocument,
  type ExportBuilderContext,
} from "@/app/lib/reports/export/reportExportBuilders";
import { buildReportWorkbookBuffer } from "@/app/lib/reports/export/xlsxWriter";
import { buildReportCsvBuffer } from "@/app/lib/reports/export/csvWriter";
import { buildReportPdfBuffer } from "@/app/lib/reports/export/pdfWriter";
import { buildExportFilename } from "@/app/lib/reports/export/exportFilename";
import type { ReportExportDocument, ReportExportFilterDescriptor, ReportExportFormat, ReportExportType } from "@/app/lib/reports/export/reportExportModel";

/**
 * Shared Report Export Foundation (Section 5). One Route Handler serves
 * every report/format combination -- Excel/CSV/PDF are three renderers
 * over the SAME ReportExportDocument each report builder produces from
 * the SAME authoritative report-service functions the on-screen pages
 * call (app/lib/reports/*.ts) -- never a sixth (or, with formats, an
 * eighteenth) hand-rolled export implementation.
 *
 * A Route Handler (not a Server Action) is used deliberately: a file
 * download needs a real HTTP response with Content-Type/
 * Content-Disposition headers, which a Server Action cannot produce
 * directly. Authorization/organization-scoping/report-type validation
 * all still happen here, server-side, exactly as Section 3/26 require --
 * nothing about using a Route Handler instead of an action changes that.
 *
 * Auth fan-out note: requireManagerOrAdmin() is called exactly ONCE
 * here. React's cache() (used by that function) memoizes per active
 * React render; a Route Handler is not a React render, so nothing would
 * be gained by calling it more than once here anyway -- keeping it to
 * one call is what matters, not relying on memoization to paper over
 * repeats.
 */

const REPORT_TYPES: ReportExportType[] = ["overview", "purchasing", "usage", "inventory-status", "waste", "receiving"];
const FORMATS: ReportExportFormat[] = ["xlsx", "csv", "pdf"];

const CONTENT_TYPE: Record<ReportExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};

function errorResponse(status: number, message: string) {
  return NextResponse.json({ ok: false, message }, { status });
}

function firstParam(searchParams: URLSearchParams, key: string): string | undefined {
  return searchParams.get(key) ?? undefined;
}

async function resolveVendorName(organizationId: string, vendorId: string | null): Promise<string | null> {
  if (!vendorId) return null;
  const { data } = await getServiceRoleClient().from("vendors").select("name").eq("organization_id", organizationId).eq("id", vendorId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

async function resolveCategoryName(organizationId: string, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const { data } = await getServiceRoleClient().from("inventory_categories").select("name").eq("organization_id", organizationId).eq("id", categoryId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

async function resolveLocationName(organizationId: string, locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  const { data } = await getServiceRoleClient().from("locations").select("name").eq("organization_id", organizationId).eq("id", locationId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const reportTypeParam = searchParams.get("report");
  const formatParam = searchParams.get("format");

  // Explicit allowlists (Section 26) -- no report/format name from the
  // query string is ever used to build a path, RPC name, or table name;
  // it only ever selects a branch below.
  if (!reportTypeParam || !REPORT_TYPES.includes(reportTypeParam as ReportExportType)) {
    return errorResponse(400, "Unsupported report type.");
  }
  if (!formatParam || !FORMATS.includes(formatParam as ReportExportFormat)) {
    return errorResponse(400, "Unsupported export format.");
  }
  const reportType = reportTypeParam as ReportExportType;
  const format = formatParam as ReportExportFormat;

  let auth: Awaited<ReturnType<typeof requireManagerOrAdmin>>;
  try {
    auth = await requireManagerOrAdmin();
  } catch (err) {
    if (err instanceof AuthInfrastructureError) {
      console.error(`[reports:export] AUTH_INFRA_FAILURE report=${reportType} format=${format} error=${err.message}`);
      return errorResponse(503, "Could not generate the report. Try again.");
    }
    throw err;
  }
  if (!auth.ok) {
    return errorResponse(auth.reason === "not_authenticated" ? 401 : 403, "You must be signed in as a manager or admin.");
  }
  const organizationId = auth.manager.organizationId;

  const periodKey = firstParam(searchParams, "period");
  const customFrom = firstParam(searchParams, "from");
  const customTo = firstParam(searchParams, "to");
  const vendorId = firstParam(searchParams, "vendor") ?? null;
  const categoryId = firstParam(searchParams, "category") ?? null;
  const locationId = firstParam(searchParams, "location") ?? null;

  const serviceClient = getServiceRoleClient();
  const timeZone = await resolveOrganizationTimezone(serviceClient, organizationId).catch(() => "America/New_York");
  // Identical resolution (same function, same inputs) as every report
  // page uses -- the export can never disagree with the on-screen date
  // range (Section 2/12).
  const period = resolveReportPeriod(new Date(), timeZone, periodKey, customFrom, customTo);

  const filters: ReportExportFilterDescriptor[] = [];
  try {
    if (reportType === "purchasing" || reportType === "receiving") {
      const vendorName = await resolveVendorName(organizationId, vendorId);
      if (vendorName) filters.push({ label: "Vendor", value: vendorName });
    }
    if (reportType === "purchasing") {
      const categoryName = await resolveCategoryName(organizationId, categoryId);
      if (categoryName) filters.push({ label: "Category", value: categoryName });
    }
    if (reportType === "waste" || reportType === "inventory-status") {
      const locationName = await resolveLocationName(organizationId, locationId);
      if (locationName) filters.push({ label: "Location", value: locationName });
    }

    const ctx: ExportBuilderContext = {
      organizationName: "Gansevoort Ops",
      timeZone,
      generatedAt: new Date(),
      dateRange: reportType === "inventory-status" ? null : { startDate: period.startDate, endDate: period.endDate },
      filters,
    };

    const doc = await buildExportDocument(reportType, ctx, organizationId, serviceClient, period.startDate, period.endDate, { vendorId, categoryId, locationId });

    console.log(
      `[reports:export] report=${reportType} format=${format} organizationId=${organizationId} dateRange=${ctx.dateRange ? `${ctx.dateRange.startDate}..${ctx.dateRange.endDate}` : "n/a"} filters=${JSON.stringify(filters)}`
    );

    const body = await renderExport(doc, format);
    const filename = buildExportFilename(reportType, format, ctx.dateRange, period.startDate);

    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPE[format],
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(`[reports:export] FAILED report=${reportType} format=${format} organizationId=${organizationId} error=${err instanceof Error ? err.message : String(err)}`);
    return errorResponse(500, "Could not generate the report. Try again.");
  }
}

async function buildExportDocument(
  reportType: ReportExportType,
  ctx: ExportBuilderContext,
  organizationId: string,
  serviceClient: ReturnType<typeof getServiceRoleClient>,
  dateFrom: string,
  dateTo: string,
  filterIds: { vendorId: string | null; categoryId: string | null; locationId: string | null }
): Promise<ReportExportDocument> {
  switch (reportType) {
    case "purchasing": {
      const [report, priceChanges] = await Promise.all([
        getPurchasingReport(serviceClient, organizationId, dateFrom, dateTo, { vendorId: filterIds.vendorId, inventoryCategoryId: filterIds.categoryId }),
        getPurchasingReportPriceChanges(serviceClient, organizationId, dateFrom, dateTo, filterIds.vendorId, filterIds.categoryId),
      ]);
      return buildPurchasingExportDocument(ctx, report, priceChanges);
    }
    case "usage": {
      const report = await getUsageReport(serviceClient, organizationId, dateFrom, dateTo);
      return buildUsageExportDocument(ctx, report);
    }
    case "waste": {
      const report = await getWasteReport(serviceClient, organizationId, dateFrom, dateTo, { locationId: filterIds.locationId });
      return buildWasteExportDocument(ctx, report);
    }
    case "receiving": {
      const report = await getReceivingReport(serviceClient, organizationId, dateFrom, dateTo, filterIds.vendorId);
      return buildReceivingExportDocument(ctx, report);
    }
    case "inventory-status": {
      const report = await getInventoryStatusReport(serviceClient, organizationId, { locationId: filterIds.locationId });
      return buildInventoryStatusExportDocument(ctx, report);
    }
    case "overview": {
      const [purchasing, receiving, usage, waste, inventoryStatus] = await Promise.all([
        getPurchasingReport(serviceClient, organizationId, dateFrom, dateTo),
        getReceivingReport(serviceClient, organizationId, dateFrom, dateTo),
        getUsageReport(serviceClient, organizationId, dateFrom, dateTo),
        getWasteReport(serviceClient, organizationId, dateFrom, dateTo),
        getInventoryStatusReport(serviceClient, organizationId),
      ]);
      return buildOverviewExportDocument(ctx, {
        purchaseValue: purchasing.totalPurchaseValue,
        purchaseDocumentCount: purchasing.documentCount,
        receivingDocumentCount: receiving.documentCount,
        readyToPostCount: receiving.readyToPostCount,
        partiallyPostedCount: receiving.partiallyPostedCount,
        lowStockCount: inventoryStatus.lowStockCount,
        outOfStockCount: inventoryStatus.outOfStockCount,
        withdrawalMovementCount: usage.movementCount,
        wasteEventCount: waste.eventCount,
      });
    }
  }
}

async function renderExport(doc: ReportExportDocument, format: ReportExportFormat): Promise<Buffer> {
  if (format === "xlsx") return buildReportWorkbookBuffer(doc);
  if (format === "csv") return buildReportCsvBuffer(doc);
  return buildReportPdfBuffer(doc);
}
