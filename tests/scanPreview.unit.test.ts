import { describe, expect, it } from "vitest";
import { movePage, rotatePage, deletePage, buildFinalizeInstructions, scanErrorMessage, type WorkingScanPage } from "@/app/manager/(app)/receiving/_lib/scanPreview";

function page(sourceIndex: number, rotationDegrees = 0): WorkingScanPage {
  return { sourceIndex, thumbnailDataUri: `data:image/jpeg;base64,page${sourceIndex}`, rotationDegrees };
}

describe("movePage", () => {
  it("swaps a page with its right neighbor", () => {
    const pages = [page(0), page(1), page(2)];
    const result = movePage(pages, 0, 1);
    expect(result.map((p) => p.sourceIndex)).toEqual([1, 0, 2]);
  });

  it("swaps a page with its left neighbor", () => {
    const pages = [page(0), page(1), page(2)];
    const result = movePage(pages, 2, -1);
    expect(result.map((p) => p.sourceIndex)).toEqual([0, 2, 1]);
  });

  it("is a no-op at the left edge", () => {
    const pages = [page(0), page(1)];
    const result = movePage(pages, 0, -1);
    expect(result).toBe(pages);
  });

  it("is a no-op at the right edge", () => {
    const pages = [page(0), page(1)];
    const result = movePage(pages, 1, 1);
    expect(result).toBe(pages);
  });
});

describe("rotatePage", () => {
  it("adds 90 degrees, wrapping at 360", () => {
    let pages = [page(0, 0)];
    pages = rotatePage(pages, 0);
    expect(pages[0].rotationDegrees).toBe(90);
    pages = rotatePage(pages, 0);
    pages = rotatePage(pages, 0);
    pages = rotatePage(pages, 0);
    expect(pages[0].rotationDegrees).toBe(0);
  });

  it("only rotates the targeted page", () => {
    const pages = [page(0), page(1)];
    const result = rotatePage(pages, 1);
    expect(result[0].rotationDegrees).toBe(0);
    expect(result[1].rotationDegrees).toBe(90);
  });
});

describe("deletePage", () => {
  it("removes exactly the targeted page, preserving order of the rest", () => {
    const pages = [page(0), page(1), page(2)];
    const result = deletePage(pages, 1);
    expect(result.map((p) => p.sourceIndex)).toEqual([0, 2]);
  });

  it("can remove down to zero pages", () => {
    const result = deletePage([page(0)], 0);
    expect(result).toHaveLength(0);
  });
});

describe("buildFinalizeInstructions", () => {
  it("reflects the array's current order, not original capture order", () => {
    // One invoice, five pages captured in order, then reordered and one
    // deleted -- the finalize instructions must reflect what the
    // manager is looking at, not the original scan order (Part
    // "MULTIPAGE NORMAL INVOICES": one scan job -> one ordered PDF).
    let pages = [page(0), page(1), page(2), page(3), page(4)];
    pages = deletePage(pages, 2); // remove original page index 2
    pages = movePage(pages, 0, 1); // swap the first two remaining pages
    const instructions = buildFinalizeInstructions(pages);
    expect(instructions).toEqual([
      { sourceIndex: 1, rotationDegrees: 0 },
      { sourceIndex: 0, rotationDegrees: 0 },
      { sourceIndex: 3, rotationDegrees: 0 },
      { sourceIndex: 4, rotationDegrees: 0 },
    ]);
  });

  it("carries each page's rotation through", () => {
    let pages = [page(0), page(1)];
    pages = rotatePage(pages, 1);
    const instructions = buildFinalizeInstructions(pages);
    expect(instructions[1]).toEqual({ sourceIndex: 1, rotationDegrees: 90 });
  });

  it("an empty working set produces no instructions", () => {
    expect(buildFinalizeInstructions([])).toEqual([]);
  });
});

describe("scanErrorMessage", () => {
  it("maps every known error code to manager-readable copy, never the raw code", () => {
    const codes = ["NO_DOCUMENT_LOADED", "PAPER_JAM", "SCANNER_BUSY", "SCANNER_OFFLINE", "DEVICE_ERROR", "TIMEOUT", "INTERNAL_ERROR"] as const;
    for (const code of codes) {
      const message = scanErrorMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(code);
      expect(message).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("has a safe fallback for an unrecognized/null code", () => {
    expect(scanErrorMessage(null).length).toBeGreaterThan(0);
  });
});
