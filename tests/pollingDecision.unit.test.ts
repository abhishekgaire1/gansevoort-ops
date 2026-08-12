import { describe, expect, it } from "vitest";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import type { DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";

describe("shouldPollForStatuses", () => {
  it("returns true when the only status is PROCESSING (document detail page)", () => {
    expect(shouldPollForStatuses(["PROCESSING"])).toBe(true);
  });

  it("returns false for each terminal/stalled status alone", () => {
    const terminal: DocumentDisplayStatus[] = ["NEEDS_REVIEW", "FAILED", "STALLED"];
    for (const status of terminal) {
      expect(shouldPollForStatuses([status])).toBe(false);
    }
  });

  it("returns false for an empty list (e.g. an empty receiving queue)", () => {
    expect(shouldPollForStatuses([])).toBe(false);
  });

  it("returns true if ANY document in the receiving queue is PROCESSING, even among mostly-settled ones", () => {
    expect(shouldPollForStatuses(["NEEDS_REVIEW", "FAILED", "PROCESSING", "STALLED"])).toBe(true);
  });

  it("returns false once every document has settled into a non-PROCESSING status", () => {
    expect(shouldPollForStatuses(["NEEDS_REVIEW", "FAILED", "STALLED", "NEEDS_REVIEW"])).toBe(false);
  });
});
