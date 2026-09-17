import type { DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";

/**
 * Hybrid extraction-progress model for the blocking "Extracting…" screen.
 *
 * There is NO genuine "percent extracted": a document is extracted by a
 * single atomic AI call (see runDocumentExtractionAttempt.ts) that returns
 * the whole result at once -- the server only ever knows PENDING (queued),
 * RUNNING (extracting), or SUCCEEDED/FAILED, never a real fraction. So the
 * percentage here is deliberately a HONEST ESTIMATE, not a measurement:
 *
 *  - Its anchors are driven by the real attempt state (queued vs running vs
 *    succeeded), so every large jump corresponds to a real event.
 *  - Between anchors it eases smoothly on elapsed wall-clock time so the bar
 *    feels alive, but it asymptotically approaches a cap (90%) and NEVER
 *    reaches it while extraction is still running -- only a real SUCCEEDED
 *    snaps it to 100%. The bar can therefore never claim completion the
 *    server hasn't confirmed.
 *
 * Pure and deterministic in `now` so the UI can tick a local clock and the
 * curve stays unit-testable.
 */

export type ExtractionPhase = "queued" | "extracting" | "finalizing" | "done" | "failed" | "stalled";

export interface ExtractionProgressInput {
  /** Derived document status (deriveDocumentStatus). */
  status: DocumentDisplayStatus;
  /** The latest extraction attempt's own raw status, or null if none yet. */
  attemptStatus: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  /** When the attempt was requested (queued), ISO string or null. */
  requestedAt: string | null;
  /** When the model call actually started (running), ISO string or null. */
  startedAt: string | null;
  /** Current wall-clock time in ms (the caller ticks this locally). */
  now: number;
  /** True while the draft is being created after a successful extraction --
   * holds the bar just shy of 100 with an "Opening draft…" label. */
  opening?: boolean;
}

export interface ExtractionProgress {
  /** Integer 0..100. Capped below 100 until extraction actually succeeds. */
  percent: number;
  phase: ExtractionPhase;
  label: string;
  /** Extraction succeeded (the flow may now open the draft). */
  done: boolean;
  /** Terminal failure the manager must act on (failed or stalled). */
  failed: boolean;
}

// Anchors. Queued ramps 6->24 over its window; running eases 25->~90 but
// never reaches the cap while still running; opening parks at 97.
const QUEUED_START = 6;
const QUEUED_END = 24;
const QUEUED_RAMP_MS = 4000;
const RUN_START = 25;
const RUN_CAP = 90;
const RUN_TAU_MS = 9000;
const OPENING_PERCENT = 97;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function elapsedMs(fromIso: string | null, now: number): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, now - from);
}

/** Queued/running easing, capped at RUN_CAP -- used for the live bar and,
 * frozen, as the "how far it had got" value shown if it then fails. */
function inFlightPercent(input: ExtractionProgressInput): number {
  const running = input.attemptStatus === "RUNNING" && input.startedAt !== null;
  if (running) {
    const t = elapsedMs(input.startedAt, input.now);
    // Exponential approach: fast at first, decelerating toward the cap,
    // never touching it.
    const eased = RUN_START + (RUN_CAP - RUN_START) * (1 - Math.exp(-t / RUN_TAU_MS));
    return clamp(eased, RUN_START, RUN_CAP - 0.001);
  }
  const t = elapsedMs(input.requestedAt, input.now);
  const ramped = QUEUED_START + (QUEUED_END - QUEUED_START) * clamp(t / QUEUED_RAMP_MS, 0, 1);
  return clamp(ramped, QUEUED_START, QUEUED_END);
}

export function computeExtractionProgress(input: ExtractionProgressInput): ExtractionProgress {
  if (input.status === "NEEDS_REVIEW") {
    if (input.opening) {
      return { percent: OPENING_PERCENT, phase: "finalizing", label: "Opening draft…", done: true, failed: false };
    }
    return { percent: 100, phase: "done", label: "Extraction complete", done: true, failed: false };
  }

  if (input.status === "FAILED") {
    return { percent: Math.floor(inFlightPercent(input)), phase: "failed", label: "Extraction failed", done: false, failed: true };
  }

  if (input.status === "STALLED") {
    return { percent: Math.floor(inFlightPercent(input)), phase: "stalled", label: "Extraction stalled", done: false, failed: true };
  }

  // PROCESSING.
  const running = input.attemptStatus === "RUNNING" && input.startedAt !== null;
  return {
    percent: Math.floor(inFlightPercent(input)),
    phase: running ? "extracting" : "queued",
    label: running ? "Reading line items…" : "Queued for extraction…",
    done: false,
    failed: false,
  };
}
