import { describe, expect, it } from "vitest";
import { formatEstimatedCost, formatTokenCount } from "@/app/lib/format/currency";

// CI-safe: pure function, no network/DB. Proves adaptive cost precision
// (Part 26/68) -- a sub-cent individual request must never render as
// "$0.00".

describe("formatEstimatedCost", () => {
  it("formats a genuine zero as $0.00", () => {
    expect(formatEstimatedCost(0)).toBe("$0.00");
  });

  it("formats ordinary aggregates with 2 decimals", () => {
    expect(formatEstimatedCost(12.84)).toBe("$12.84");
    expect(formatEstimatedCost(31.28)).toBe("$31.28");
  });

  it("never rounds a small-but-nonzero cost down to $0.00", () => {
    expect(formatEstimatedCost(0.0038)).toBe("$0.0038");
    expect(formatEstimatedCost(0.004)).toBe("$0.0040");
    expect(formatEstimatedCost(0.0000042)).not.toBe("$0.00");
  });

  it("uses exactly 2 decimals right at the 1-cent boundary", () => {
    expect(formatEstimatedCost(0.01)).toBe("$0.01");
  });
});

describe("formatTokenCount", () => {
  it("formats small counts as-is", () => {
    expect(formatTokenCount(326)).toBe("326");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatTokenCount(326_000)).toBe("326.0K");
  });

  it("formats millions with an M suffix", () => {
    expect(formatTokenCount(1_840_000)).toBe("1.84M");
  });
});
