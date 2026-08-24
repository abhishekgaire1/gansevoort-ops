import { describe, expect, it } from "vitest";
import { reportLabelForPathname } from "@/app/manager/(app)/reports/_lib/reportErrorLabel";

// CI-safe: pure pathname mapping, no network, no database, no React render.

describe("reportLabelForPathname", () => {
  it("maps every known report route to its own name", () => {
    expect(reportLabelForPathname("/manager/reports")).toBe("Reports Overview");
    expect(reportLabelForPathname("/manager/reports/purchasing")).toBe("Purchasing Report");
    expect(reportLabelForPathname("/manager/reports/usage")).toBe("Inventory Usage Report");
    expect(reportLabelForPathname("/manager/reports/inventory-status")).toBe("Inventory Status Report");
    expect(reportLabelForPathname("/manager/reports/waste")).toBe("Waste Report");
    expect(reportLabelForPathname("/manager/reports/receiving")).toBe("Receiving Report");
  });

  it("falls back to a generic label for an unknown path -- never blank/undefined", () => {
    expect(reportLabelForPathname("/manager/reports/something-new")).toBe("Report");
  });

  it("falls back to a generic label for a null pathname", () => {
    expect(reportLabelForPathname(null)).toBe("Report");
  });
});
