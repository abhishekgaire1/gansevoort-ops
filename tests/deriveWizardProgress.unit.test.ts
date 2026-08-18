import { describe, expect, it } from "vitest";
import { deriveWizardProgress } from "@/app/lib/purchaseDocuments/deriveWizardProgress";

describe("deriveWizardProgress", () => {
  it("starts on step 1 when nothing is complete", () => {
    const { activeStep, steps } = deriveWizardProgress({ step1Complete: false, step2Complete: null, step3Complete: null });
    expect(activeStep).toBe(1);
    expect(steps.find((s) => s.id === 1)?.state).toBe("current");
    expect(steps.find((s) => s.id === 2)?.state).toBe("not_started");
    expect(steps.find((s) => s.id === 3)?.state).toBe("not_started");
    expect(steps.find((s) => s.id === 4)?.state).toBe("not_started");
  });

  it("advances to step 2 once step 1 is complete", () => {
    const { activeStep, steps } = deriveWizardProgress({ step1Complete: true, step2Complete: null, step3Complete: null });
    expect(activeStep).toBe(2);
    expect(steps.find((s) => s.id === 1)?.state).toBe("complete");
    expect(steps.find((s) => s.id === 2)?.state).toBe("current");
  });

  it("advances to step 3 once steps 1 and 2 are complete", () => {
    const { activeStep, steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: null });
    expect(activeStep).toBe(3);
    expect(steps.find((s) => s.id === 2)?.state).toBe("complete");
    expect(steps.find((s) => s.id === 3)?.state).toBe("current");
  });

  it("lands on step 4 once everything upstream is complete", () => {
    const { activeStep, steps } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: true });
    expect(activeStep).toBe(4);
    expect(steps.every((s) => s.id === 4 || s.state === "complete")).toBe(true);
    expect(steps.find((s) => s.id === 4)?.state).toBe("current");
  });

  it("flags step 2 as needing attention (e.g. a STALE line) instead of merely current", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: false, step3Complete: null, step2NeedsAttention: true });
    expect(steps.find((s) => s.id === 2)?.state).toBe("needs_attention");
  });

  it("allows backward navigation to any already-completed step", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: true, step3Complete: true, requestedStep: 1 });
    expect(activeStep).toBe(1);
  });

  it("never allows jumping ahead of the furthest reachable step", () => {
    const { activeStep } = deriveWizardProgress({ step1Complete: true, step2Complete: false, step3Complete: null, requestedStep: 4 });
    expect(activeStep).toBe(2);
  });

  it("treats step2Complete=null as incomplete even if step1 is done, never falsely marking it complete before data loads", () => {
    const { steps } = deriveWizardProgress({ step1Complete: true, step2Complete: null, step3Complete: null });
    expect(steps.find((s) => s.id === 2)?.state).not.toBe("complete");
  });
});
