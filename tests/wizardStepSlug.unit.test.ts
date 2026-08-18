import { describe, expect, it } from "vitest";
import { WIZARD_STEP_SLUGS, wizardStepFromSlug } from "@/app/lib/purchaseDocuments/wizardStepSlug";

describe("wizardStepFromSlug", () => {
  it("maps each known slug back to its step id", () => {
    expect(wizardStepFromSlug("invoice")).toBe(1);
    expect(wizardStepFromSlug("items")).toBe(2);
    expect(wizardStepFromSlug("receiving")).toBe(3);
    expect(wizardStepFromSlug("review")).toBe(4);
  });

  it("returns null for an unknown or missing slug, never guessing a step", () => {
    expect(wizardStepFromSlug("bogus")).toBeNull();
    expect(wizardStepFromSlug(null)).toBeNull();
    expect(wizardStepFromSlug("")).toBeNull();
  });

  it("every step id has a slug and round-trips", () => {
    for (const [id, slug] of Object.entries(WIZARD_STEP_SLUGS)) {
      expect(wizardStepFromSlug(slug)).toBe(Number(id));
    }
  });
});
