import { describe, expect, it } from "vitest";
import { computeExtractionProgress, type ExtractionProgressInput } from "@/app/lib/documents/extractionProgress";

/**
 * The blocking "Extracting…" screen's honest-estimate progress curve.
 * There is no real "percent extracted" (one atomic AI call), so these
 * tests pin the two guarantees that make the estimate honest: it never
 * claims completion the server hasn't confirmed (capped < 100 until
 * SUCCEEDED), and it only ever moves forward as time passes.
 */

const REQUESTED = "2026-09-17T10:00:00.000Z";
const REQUESTED_MS = new Date(REQUESTED).getTime();
const STARTED = "2026-09-17T10:00:02.000Z";
const STARTED_MS = new Date(STARTED).getTime();

function queued(elapsedMs: number): ExtractionProgressInput {
  return { status: "PROCESSING", attemptStatus: "PENDING", requestedAt: REQUESTED, startedAt: null, now: REQUESTED_MS + elapsedMs };
}
function running(elapsedMs: number, opts: Partial<ExtractionProgressInput> = {}): ExtractionProgressInput {
  return { status: "PROCESSING", attemptStatus: "RUNNING", requestedAt: REQUESTED, startedAt: STARTED, now: STARTED_MS + elapsedMs, ...opts };
}

describe("computeExtractionProgress", () => {
  it("queued (PENDING) ramps from ~6% and stays within the queued band", () => {
    expect(computeExtractionProgress(queued(0)).percent).toBe(6);
    expect(computeExtractionProgress(queued(0)).phase).toBe("queued");
    const midway = computeExtractionProgress(queued(2000)).percent;
    expect(midway).toBeGreaterThan(6);
    expect(midway).toBeLessThanOrEqual(24);
    // Never exceeds the queued ceiling no matter how long it waits.
    expect(computeExtractionProgress(queued(60_000)).percent).toBe(24);
  });

  it("running (RUNNING) starts at 25% and eases up toward, but never reaches, the 90% cap", () => {
    expect(computeExtractionProgress(running(0)).percent).toBe(25);
    expect(computeExtractionProgress(running(0)).phase).toBe("extracting");
    expect(computeExtractionProgress(running(0)).label).toBe("Reading line items…");
    // Even after a very long time it is capped strictly below 90.
    expect(computeExtractionProgress(running(10 * 60_000)).percent).toBeLessThan(90);
    expect(computeExtractionProgress(running(10 * 60_000)).percent).toBeGreaterThanOrEqual(89);
  });

  it("is monotonic non-decreasing as time advances within a phase and across the queued→running handoff", () => {
    let last = -1;
    for (const t of [0, 500, 1000, 2000, 3000, 4000]) {
      const p = computeExtractionProgress(queued(t)).percent;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    // Running begins at 25, which is >= the queued ceiling of 24 -- no
    // backward jump at the handoff.
    expect(computeExtractionProgress(running(0)).percent).toBeGreaterThanOrEqual(computeExtractionProgress(queued(60_000)).percent);
    last = -1;
    for (const t of [0, 1000, 3000, 9000, 30_000]) {
      const p = computeExtractionProgress(running(t)).percent;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it("only a real SUCCEEDED (NEEDS_REVIEW) snaps to 100%", () => {
    const done = computeExtractionProgress({ status: "NEEDS_REVIEW", attemptStatus: "SUCCEEDED", requestedAt: REQUESTED, startedAt: STARTED, now: STARTED_MS + 5000 });
    expect(done.percent).toBe(100);
    expect(done.phase).toBe("done");
    expect(done.done).toBe(true);
    expect(done.failed).toBe(false);
  });

  it("holds just shy of 100% while the draft is being opened after success", () => {
    const opening = computeExtractionProgress({ status: "NEEDS_REVIEW", attemptStatus: "SUCCEEDED", requestedAt: REQUESTED, startedAt: STARTED, now: STARTED_MS + 5000, opening: true });
    expect(opening.percent).toBe(97);
    expect(opening.phase).toBe("finalizing");
    expect(opening.label).toBe("Opening draft…");
    expect(opening.done).toBe(true);
  });

  it("marks FAILED and STALLED as terminal failures the manager must act on, never done", () => {
    const failed = computeExtractionProgress(running(3000, { status: "FAILED", attemptStatus: "FAILED" }));
    expect(failed.failed).toBe(true);
    expect(failed.done).toBe(false);
    expect(failed.phase).toBe("failed");

    const stalled = computeExtractionProgress(running(3000, { status: "STALLED" }));
    expect(stalled.failed).toBe(true);
    expect(stalled.done).toBe(false);
    expect(stalled.phase).toBe("stalled");
  });
});
