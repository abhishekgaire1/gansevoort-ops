import { describe, expect, it } from "vitest";
import { blockingIssueSummaryLabel } from "@/app/components/receiving/blockingIssues";

describe("blockingIssueSummaryLabel", () => {
  it("returns an empty string for zero issues -- nothing to summarize", () => {
    expect(blockingIssueSummaryLabel(0)).toBe("");
  });

  it("singularizes noun and verb for exactly one issue", () => {
    expect(blockingIssueSummaryLabel(1)).toBe("1 item needs attention");
  });

  it("pluralizes for more than one issue", () => {
    expect(blockingIssueSummaryLabel(2)).toBe("2 items need attention");
  });

  it("accepts a custom noun (e.g. 'line')", () => {
    expect(blockingIssueSummaryLabel(3, "line")).toBe("3 lines need attention");
    expect(blockingIssueSummaryLabel(1, "line")).toBe("1 line needs attention");
  });
});
