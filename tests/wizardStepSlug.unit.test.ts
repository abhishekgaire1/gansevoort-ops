import { describe, expect, it } from "vitest";
import { WIZARD_STEP_SLUGS, wizardStepFromSlug } from "@/app/lib/purchaseDocuments/wizardStepSlug";

describe("wizardStepFromSlug", () => {
  it("maps each known slug back to its step id", () => {
    expect(wizardStepFromSlug("invoice")).toBe(1);
    expect(wizardStepFromSlug("items")).toBe(2);
    expect(wizardStepFromSlug("review")).toBe(3);
  });

  it("test 13: an old Step 3 (receiving) link redirects safely to the new combined step, never a cold restart", () => {
    expect(wizardStepFromSlug("receiving")).toBe(2);
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
