/**
 * A PENDING/RUNNING attempt must not display "Processing" forever if its
 * executor invocation silently never ran or never finished (e.g. after()
 * didn't fire, or the process died mid-extraction). No cron/worker exists
 * yet to sweep these automatically -- staleness is instead detected
 * on-read (queue/detail display) and resolved on-demand (the manager's
 * "Retry Extraction" click terminalizes the stale attempt before starting
 * a new one). This function is pure and shared by both paths so the
 * threshold is defined in exactly one place.
 */
export const STALE_EXTRACTION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface AttemptTimingInfo {
  status: string;
  requestedAt: string;
  startedAt: string | null;
}

export function isAttemptStale(attempt: AttemptTimingInfo, now: Date = new Date()): boolean {
  if (attempt.status !== "PENDING" && attempt.status !== "RUNNING") {
    return false;
  }

  const referenceTime = attempt.status === "RUNNING" && attempt.startedAt ? attempt.startedAt : attempt.requestedAt;
  const elapsedMs = now.getTime() - new Date(referenceTime).getTime();
  return elapsedMs > STALE_EXTRACTION_THRESHOLD_MS;
}
