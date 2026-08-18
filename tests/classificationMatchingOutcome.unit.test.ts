import { describe, expect, it } from "vitest";
import { decideMatchingOutcome } from "@/app/lib/itemMaster/classificationMatchingOutcome";

describe("decideMatchingOutcome", () => {
  it("resolves when the run is no longer active and did not fail", () => {
    expect(decideMatchingOutcome({ active: false, outcome: "SUCCEEDED" })).toBe("resolved");
    expect(decideMatchingOutcome({ active: false, outcome: "ABANDONED" })).toBe("resolved");
    expect(decideMatchingOutcome({ active: false, outcome: null })).toBe("resolved");
  });

  it("reports stillActive when the poll cap was reached but a run is genuinely still claimed -- never mistaken for failure or silently retried as a fresh run", () => {
    expect(decideMatchingOutcome({ active: true, outcome: null })).toBe("stillActive");
  });

  it("reports failed only when the run actually finished with outcome FAILED", () => {
    expect(decideMatchingOutcome({ active: false, outcome: "FAILED" })).toBe("failed");
  });

  it("reports unknown when the status could not be determined at all, rather than assuming success", () => {
    expect(decideMatchingOutcome(null)).toBe("unknown");
  });
});
