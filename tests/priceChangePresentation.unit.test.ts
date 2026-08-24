import { describe, expect, it } from "vitest";
import { priceChangeTone } from "@/app/lib/purchasing/priceChangePresentation";

// CI-safe: pure presentation mapping, no network, no database.
// Section 20 -- verify component semantics/classes.

describe("priceChangeTone", () => {
  it("increase -> red change indicator with an up arrow", () => {
    expect(priceChangeTone("increase")).toEqual({ glyph: "↑", colorClass: "text-red-400" });
  });

  it("decrease -> green change indicator with a down arrow", () => {
    expect(priceChangeTone("decrease")).toEqual({ glyph: "↓", colorClass: "text-emerald-400" });
  });

  it("unchanged -> muted neutral, never red or green, with an approx-equal glyph", () => {
    const tone = priceChangeTone("unchanged");
    expect(tone.glyph).toBe("≈");
    expect(tone.colorClass).not.toMatch(/red|emerald|green/);
    expect(tone.colorClass).toBe("text-zinc-500");
  });

  it("every direction has a distinct glyph -- the signal never depends on color alone", () => {
    const glyphs = new Set([priceChangeTone("increase").glyph, priceChangeTone("decrease").glyph, priceChangeTone("unchanged").glyph]);
    expect(glyphs.size).toBe(3);
  });
});
