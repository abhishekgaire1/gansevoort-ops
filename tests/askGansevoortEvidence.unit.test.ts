import { describe, expect, it } from "vitest";
import { buildEvidenceHref, makeEvidence, isKnownEvidenceSourceType } from "@/app/lib/ai/tasks/chat/evidence";

// CI-safe: pure functions, no network, no database.

describe("buildEvidenceHref -- an explicit allowlist, never a model/DB-supplied URL", () => {
  it("maps every known source type to its correct manager route", () => {
    expect(buildEvidenceHref("inventory_status", null)).toBe("/manager/reports/inventory-status");
    expect(buildEvidenceHref("purchasing_report", null)).toBe("/manager/reports/purchasing");
    expect(buildEvidenceHref("receiving_report", null)).toBe("/manager/reports/receiving");
    expect(buildEvidenceHref("usage_report", null)).toBe("/manager/reports/usage");
    expect(buildEvidenceHref("waste_report", null)).toBe("/manager/reports/waste");
    expect(buildEvidenceHref("reports_overview", null)).toBe("/manager/reports");
    expect(buildEvidenceHref("cycle_count", "cc-1")).toBe("/manager/inventory/cycle-count/cc-1");
    expect(buildEvidenceHref("inventory_alert", "exc-1")).toBe("/manager/inventory/alerts/exc-1");
    expect(buildEvidenceHref("item_detail", "item-1")).toBe("/manager/inventory/items/item-1");
    // 19. purchase_document -- the one route that visibly shows the
    // vendor, document date, line items and price backing a cost claim.
    expect(buildEvidenceHref("purchase_document", "doc-1")).toBe("/manager/purchases/doc-1");
  });

  it("falls back to a safe list route when a record-level source has no id", () => {
    expect(buildEvidenceHref("cycle_count", null)).toBe("/manager/inventory/cycle-count");
    expect(buildEvidenceHref("inventory_alert", null)).toBe("/manager/inventory/alerts");
    expect(buildEvidenceHref("purchase_document", null)).toBe("/manager/receiving");
  });

  it("an unsupported source type safely falls back to '#', never a broken or raw URL", () => {
    // @ts-expect-error -- deliberately testing an out-of-allowlist value
    expect(buildEvidenceHref("some_future_source_type", "x")).toBe("#");
  });
});

describe("isKnownEvidenceSourceType", () => {
  it("accepts only the allowlisted values", () => {
    expect(isKnownEvidenceSourceType("inventory_status")).toBe(true);
    expect(isKnownEvidenceSourceType("javascript:alert(1)")).toBe(false);
    expect(isKnownEvidenceSourceType("https://evil.example.com")).toBe(false);
  });
});

describe("makeEvidence -- the ONLY place an evidence card is constructed, always server-side", () => {
  it("builds a fully-shaped evidence object with a correct, allowlisted href", () => {
    const evidence = makeEvidence({ label: "Purchasing Report", sourceType: "purchasing_report", period: { startDate: "2026-08-01", endDate: "2026-08-19" } });
    expect(evidence).toMatchObject({
      label: "Purchasing Report",
      sourceType: "purchasing_report",
      sourceId: null,
      href: "/manager/reports/purchasing",
      period: { startDate: "2026-08-01", endDate: "2026-08-19" },
      asOf: null,
    });
    expect(typeof evidence.id).toBe("string");
    expect(evidence.id.length).toBeGreaterThan(0);
  });

  it("produces a unique id for each call, even with identical inputs", () => {
    const a = makeEvidence({ label: "X", sourceType: "reports_overview" });
    const b = makeEvidence({ label: "X", sourceType: "reports_overview" });
    expect(a.id).not.toBe(b.id);
  });
});
