import { describe, expect, it } from "vitest";
import { translateReviewFlags } from "@/app/lib/purchaseDocuments/reviewFlagText";

describe("translateReviewFlags", () => {
  it("passes a header-level flag's message through untouched, with no code/field noise", () => {
    const [translated] = translateReviewFlags(
      [{ severity: "error", code: "MISSING_INVOICE_DATE", message: "Invoice date was not found." }],
      []
    );
    expect(translated).toEqual({ severity: "error", text: "Invoice date was not found.", lineIndex: null });
  });

  it("builds an item-name-led message for a known line-level code, using the line's own description", () => {
    const [translated] = translateReviewFlags(
      [{ severity: "warning", code: "LINE_MISSING_PACKAGE_UNIT", field: "lines[0].packageUnit", message: "Line 1 has a package quantity but no package unit." }],
      [{ description: "Heavy Cream 40% Quart" }]
    );
    expect(translated.text).toBe("Heavy Cream 40% Quart — invoice quantity unit could not be identified.");
    expect(translated.lineIndex).toBe(0);
  });

  it("falls back to Line N when the line has no description", () => {
    const [translated] = translateReviewFlags(
      [{ severity: "warning", code: "LINE_MISSING_MEASURED_UNIT", field: "lines[2].measuredUnit", message: "Line 3 has a measured quantity but no measured unit." }],
      [{ description: null }, { description: null }, { description: null }]
    );
    expect(translated.text).toBe("Line 3 — measured quantity unit could not be identified.");
  });

  it("falls back to the flag's own message for an unrecognized code, never hiding it", () => {
    const [translated] = translateReviewFlags(
      [{ severity: "warning", code: "SOME_FUTURE_CODE", field: "lines[1].somethingNew", message: "Line 2 has a brand new kind of problem." }],
      [{ description: "Item A" }, { description: "Item B" }]
    );
    expect(translated.text).toBe("Line 2 has a brand new kind of problem.");
    expect(translated.lineIndex).toBe(1);
  });

  it("never lets a raw [severity] CODE (field): prefix leak into the translated text", () => {
    const results = translateReviewFlags(
      [
        { severity: "error", code: "LINE_NEGATIVE_TOTAL", field: "lines[0].lineTotal", message: "Line 1 has a negative line total." },
        { severity: "warning", code: "TOTAL_MISMATCH", message: "Line totals + tax + fees (100.00) do not match the entered total (99.00)." },
      ],
      [{ description: "Radish" }]
    );
    for (const r of results) {
      expect(r.text).not.toMatch(/^\[/);
      expect(r.text).not.toContain("(lines[");
    }
  });
});
