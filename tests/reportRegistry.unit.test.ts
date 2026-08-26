import { describe, expect, it } from "vitest";
import { REPORT_REGISTRY, getReportDefinition } from "@/app/lib/reports/registry";
import { REPORT_IDS } from "@/app/lib/reports/registry/types";

// CI-safe: pure structural checks against the real registry -- no
// network/DB (loadReport itself is never invoked here). Covers Section
// 20 items 1-9 (registry and validation).

describe("REPORT_REGISTRY -- structural integrity", () => {
  it("has exactly one definition per registered report id, no duplicates, no gaps", () => {
    const keys = Object.keys(REPORT_REGISTRY);
    expect(keys.sort()).toEqual([...REPORT_IDS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every definition's own id matches the key it's registered under", () => {
    for (const [key, def] of Object.entries(REPORT_REGISTRY)) {
      expect(def.id).toBe(key);
    }
  });

  it("every definition declares a loader, a column allowlist, and dataset limitations", () => {
    for (const def of Object.values(REPORT_REGISTRY)) {
      expect(typeof def.loadReport).toBe("function");
      expect(Array.isArray(def.columns)).toBe(true);
      expect(def.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(def.datasetLimitations)).toBe(true);
    }
  });

  it("getReportDefinition rejects an unregistered report id", () => {
    expect(getReportDefinition("sales")).toBeNull();
    expect(getReportDefinition("")).toBeNull();
    expect(getReportDefinition("purchasing__proto__")).toBeNull();
  });

  it("getReportDefinition resolves every registered id", () => {
    for (const id of REPORT_IDS) {
      expect(getReportDefinition(id)?.id).toBe(id);
    }
  });

  it("default and required column keys are always a subset of the report's own column allowlist", () => {
    for (const def of Object.values(REPORT_REGISTRY)) {
      const columnKeys = new Set(def.columns.map((c) => c.key));
      for (const key of def.defaultColumnKeys) expect(columnKeys.has(key)).toBe(true);
      for (const key of def.requiredColumnKeys) expect(columnKeys.has(key)).toBe(true);
    }
  });

  it("required filter keys always reference an actually-registered filter", () => {
    for (const def of Object.values(REPORT_REGISTRY)) {
      const filterKeys = new Set(def.filters.map((f) => f.key));
      for (const key of def.requiredFilterKeys) expect(filterKeys.has(key)).toBe(true);
    }
  });

  it("default grouping, when set, references an actually-registered grouping", () => {
    for (const def of Object.values(REPORT_REGISTRY)) {
      if (def.defaultGrouping === null) continue;
      expect(def.groupings.some((g) => g.key === def.defaultGrouping)).toBe(true);
    }
  });

  it("point-in-time reports declare a null maxRangeDays and only support point_in_time; date-ranged reports declare a positive maxRangeDays and never support point_in_time", () => {
    for (const def of Object.values(REPORT_REGISTRY)) {
      if (def.isPointInTime) {
        expect(def.maxRangeDays).toBeNull();
        expect(def.supportedDateKinds).toEqual(["point_in_time"]);
      } else {
        expect(def.maxRangeDays).toBeGreaterThan(0);
        expect(def.supportedDateKinds).not.toContain("point_in_time");
      }
    }
  });

  it("item_cost_history requires a resolved item (Section 12)", () => {
    expect(REPORT_REGISTRY.item_cost_history.requiredFilterKeys).toContain("item");
  });

  it("receiving and cycle_counts correctly declare no pricing support -- their datasets carry no dollar amounts", () => {
    expect(REPORT_REGISTRY.receiving.pricingMode).toBe("not_supported");
    expect(REPORT_REGISTRY.cycle_counts.pricingMode).toBe("not_supported");
  });

  it("waste, usage, inventory_status and inventory_alerts declare estimated pricing; purchasing and item_cost_history declare actual pricing", () => {
    expect(REPORT_REGISTRY.waste.pricingMode).toBe("estimated");
    expect(REPORT_REGISTRY.usage.pricingMode).toBe("estimated");
    expect(REPORT_REGISTRY.inventory_status.pricingMode).toBe("estimated");
    expect(REPORT_REGISTRY.inventory_alerts.pricingMode).toBe("estimated");
    expect(REPORT_REGISTRY.purchasing.pricingMode).toBe("actual");
    expect(REPORT_REGISTRY.item_cost_history.pricingMode).toBe("actual");
  });
});
