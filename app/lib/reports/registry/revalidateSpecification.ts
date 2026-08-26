import "server-only";
import { z } from "zod";
import type { ReportDefinition, ReportRuntimeContext, ResolvedReportFilter, ResolvedReportSpecification } from "@/app/lib/reports/registry/types";
import { resolveColumns } from "@/app/lib/reports/registry/resolveColumns";

/**
 * General Report Builder -- download-route re-validation (Section 11).
 * The client (chat drawer) sends back the EXACT ResolvedReportSpecification
 * the chat tool produced, but this is always treated as an untrusted
 * REQUEST, never as authorization: every field is independently
 * re-checked against the registry and the authenticated organization
 * here. A tampered client can, at most, ask for a different ALLOWLISTED
 * filter/column/grouping already registered for this report -- it can
 * never escape the organization, widen the date range past the report's
 * own ceiling, or reference an id belonging to a different organization.
 */

const wireSpecSchema = z
  .object({
    reportId: z.string().min(1).max(60),
    dateRange: z
      .object({
        startDate: z.string().max(10),
        endDate: z.string().max(10),
        isPointInTime: z.boolean(),
      })
      .strict(),
    filters: z
      .array(z.object({ key: z.string().max(40), label: z.string().max(80), id: z.string().max(200), name: z.string().max(200) }).strict())
      .max(6),
    grouping: z.string().max(40).nullable(),
    columns: z.array(z.string().max(60)).max(20),
    includePricing: z.boolean(),
    format: z.literal("xlsx"),
  })
  .strict();

export type RevalidationResult = { ok: true; spec: ResolvedReportSpecification } | { ok: false; message: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function inclusiveDaySpan(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

export async function revalidateReportSpecification(ctx: ReportRuntimeContext, def: ReportDefinition, rawSpec: unknown): Promise<RevalidationResult> {
  const parsed = wireSpecSchema.safeParse(rawSpec);
  if (!parsed.success) return { ok: false, message: "The report request is malformed." };
  const wire = parsed.data;

  if (wire.reportId !== def.id) return { ok: false, message: "Report id mismatch." };

  // Date range -- re-derived boundaries are re-checked from scratch,
  // never trusted just because the shape looks right.
  if (def.isPointInTime) {
    if (!wire.dateRange.isPointInTime) return { ok: false, message: "This report is point-in-time; it does not accept a date range." };
  } else {
    if (wire.dateRange.isPointInTime) return { ok: false, message: "This report requires a date range." };
    if (!DATE_PATTERN.test(wire.dateRange.startDate) || !DATE_PATTERN.test(wire.dateRange.endDate)) return { ok: false, message: "The requested date range is invalid." };
    if (wire.dateRange.startDate > wire.dateRange.endDate) return { ok: false, message: "The start date must be on or before the end date." };
    if (def.maxRangeDays !== null && inclusiveDaySpan(wire.dateRange.startDate, wire.dateRange.endDate) > def.maxRangeDays) {
      return { ok: false, message: `This report supports a maximum range of ${def.maxRangeDays} days.` };
    }
  }

  // Filters -- every key must be registered for THIS report, and every
  // lookup filter's id must be re-proven to exist within the
  // AUTHENTICATED organization right now (never trusted from the wire).
  const resolvedFilters: ResolvedReportFilter[] = [];
  for (const filter of wire.filters) {
    const filterDef = def.filters.find((f) => f.key === filter.key);
    if (!filterDef) return { ok: false, message: `"${filter.key}" is not a supported filter for ${def.name}.` };
    if (filterDef.kind === "enum") {
      if (!filterDef.allowedValues.includes(filter.id)) return { ok: false, message: `"${filter.id}" is not a supported value for ${filterDef.label}.` };
      resolvedFilters.push({ key: filterDef.key, label: filterDef.label, id: filter.id, name: filter.id });
      continue;
    }
    // A lookup filter's resolver, called again with the id itself,
    // proves the id still exists and belongs to this organization
    // (resolve() always scopes by ctx.organizationId) -- an id from a
    // different organization, or one that no longer exists, resolves to
    // not_found/ambiguous, never silently accepted.
    const outcome = await filterDef.resolve(ctx, filter.name);
    if (outcome.status !== "resolved" || outcome.id !== filter.id) {
      return { ok: false, message: `"${filter.key}" could not be re-verified for this organization.` };
    }
    resolvedFilters.push({ key: filterDef.key, label: filterDef.label, id: outcome.id, name: outcome.name });
  }
  const missingRequired = def.requiredFilterKeys.filter((key) => !resolvedFilters.some((f) => f.key === key));
  if (missingRequired.length > 0) return { ok: false, message: `${def.name} requires: ${missingRequired.join(", ")}.` };

  const grouping = wire.grouping && def.groupings.some((g) => g.key === wire.grouping) ? wire.grouping : null;
  const columns = resolveColumns(def.columns, wire.columns, def.defaultColumnKeys, def.requiredColumnKeys, def.maxColumns).map((c) => c.key);
  const includePricing = def.pricingMode === "not_supported" ? false : wire.includePricing;

  return {
    ok: true,
    spec: {
      reportId: def.id,
      dateRange: wire.dateRange,
      filters: resolvedFilters,
      grouping,
      columns,
      includePricing,
      format: "xlsx",
    },
  };
}
