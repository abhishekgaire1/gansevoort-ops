import "server-only";
import { EVIDENCE_SOURCE_TYPES, type ChatEvidence, type EvidenceSourceType } from "@/app/lib/ai/tasks/chat/contract";

/**
 * Builds an evidence card's manager-route href from a TRUSTED, server-
 * chosen sourceType/sourceId -- mirrors app/lib/notifications/entityHref.ts's
 * own pattern (a fixed allowlist of known routes, never a raw or
 * model-generated URL). The model never sees or supplies a URL; it only
 * ever sees the evidence objects THIS function already built.
 */
export function buildEvidenceHref(sourceType: EvidenceSourceType, sourceId: string | null): string {
  switch (sourceType) {
    case "inventory_status":
      return "/manager/reports/inventory-status";
    case "purchasing_report":
      // sourceId, when present, is a VENDOR id -- the Purchasing Report
      // page itself only reads period/from/to/vendor/category from the
      // URL (never an item id -- see app/manager/(app)/reports/purchasing/
      // page.tsx), so "vendor" is the only supported filter this evidence
      // link may ever add.
      return sourceId ? `/manager/reports/purchasing?vendor=${sourceId}` : "/manager/reports/purchasing";
    case "receiving_report":
      return "/manager/reports/receiving";
    case "usage_report":
      return "/manager/reports/usage";
    case "waste_report":
      return "/manager/reports/waste";
    case "reports_overview":
      return "/manager/reports";
    case "cycle_count":
      return sourceId ? `/manager/inventory/cycle-count/${sourceId}` : "/manager/inventory/cycle-count";
    case "inventory_alert":
      return sourceId ? `/manager/inventory/alerts/${sourceId}` : "/manager/inventory/alerts";
    case "item_detail":
      return sourceId ? `/manager/inventory/items/${sourceId}` : "/manager/inventory";
    case "purchase_document":
      // The actual verified source document -- the one route that
      // visibly shows the vendor, document date, line items and prices
      // backing a cost claim (Item Detail alone does not display price).
      return sourceId ? `/manager/purchases/${sourceId}` : "/manager/receiving";
    default:
      return "#";
  }
}

let evidenceCounter = 0;

/** Every evidence card handed to the model/client is built here, server
 * side, from a trusted sourceType -- never accepted from tool output or
 * model output as a pre-built object. */
export function makeEvidence(input: {
  label: string;
  sourceType: EvidenceSourceType;
  sourceId?: string | null;
  period?: { startDate: string; endDate: string } | null;
  asOf?: string | null;
}): ChatEvidence {
  evidenceCounter += 1;
  return {
    id: `ev-${Date.now().toString(36)}-${evidenceCounter}`,
    label: input.label,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    href: buildEvidenceHref(input.sourceType, input.sourceId ?? null),
    period: input.period ?? null,
    asOf: input.asOf ?? null,
  };
}

export function isKnownEvidenceSourceType(value: string): value is EvidenceSourceType {
  return (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value);
}
