import { describe, expect, it } from "vitest";
import { isAttemptStale, STALE_EXTRACTION_THRESHOLD_MS } from "@/app/lib/documents/staleExtraction";
import { deriveDocumentStatus } from "@/app/lib/documents/documentStatus";
import { safeExtractionErrorMessage } from "@/app/lib/documents/extractionErrorMessages";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const JUST_UNDER = new Date(NOW.getTime() - (STALE_EXTRACTION_THRESHOLD_MS - 1000)).toISOString();
const JUST_OVER = new Date(NOW.getTime() - (STALE_EXTRACTION_THRESHOLD_MS + 1000)).toISOString();

describe("isAttemptStale", () => {
  it("a PENDING attempt within the threshold is not stale", () => {
    expect(isAttemptStale({ status: "PENDING", requestedAt: JUST_UNDER, startedAt: null }, NOW)).toBe(false);
  });

  it("a PENDING attempt past the threshold is stale", () => {
    expect(isAttemptStale({ status: "PENDING", requestedAt: JUST_OVER, startedAt: null }, NOW)).toBe(true);
  });

  it("a RUNNING attempt is measured from startedAt, not requestedAt", () => {
    // requested long ago (would be stale by itself), but started recently
    expect(isAttemptStale({ status: "RUNNING", requestedAt: JUST_OVER, startedAt: JUST_UNDER }, NOW)).toBe(false);
  });

  it("a RUNNING attempt past the threshold since startedAt is stale", () => {
    expect(isAttemptStale({ status: "RUNNING", requestedAt: JUST_OVER, startedAt: JUST_OVER }, NOW)).toBe(true);
  });

  it("a terminal attempt (SUCCEEDED/FAILED) is never stale, regardless of age", () => {
    expect(isAttemptStale({ status: "SUCCEEDED", requestedAt: JUST_OVER, startedAt: JUST_OVER }, NOW)).toBe(false);
    expect(isAttemptStale({ status: "FAILED", requestedAt: JUST_OVER, startedAt: JUST_OVER }, NOW)).toBe(false);
  });
});

describe("deriveDocumentStatus", () => {
  it("no attempt at all is treated as FAILED (visible retry action)", () => {
    expect(deriveDocumentStatus(null, NOW)).toBe("FAILED");
  });

  it("SUCCEEDED maps to NEEDS_REVIEW", () => {
    expect(deriveDocumentStatus({ status: "SUCCEEDED", requestedAt: JUST_UNDER, startedAt: null }, NOW)).toBe("NEEDS_REVIEW");
  });

  it("FAILED maps to FAILED", () => {
    expect(deriveDocumentStatus({ status: "FAILED", requestedAt: JUST_UNDER, startedAt: null }, NOW)).toBe("FAILED");
  });

  it("a fresh PENDING/RUNNING attempt maps to PROCESSING", () => {
    expect(deriveDocumentStatus({ status: "PENDING", requestedAt: JUST_UNDER, startedAt: null }, NOW)).toBe("PROCESSING");
    expect(deriveDocumentStatus({ status: "RUNNING", requestedAt: JUST_OVER, startedAt: JUST_UNDER }, NOW)).toBe("PROCESSING");
  });

  it("a stale PENDING/RUNNING attempt maps to STALLED, not PROCESSING", () => {
    expect(deriveDocumentStatus({ status: "PENDING", requestedAt: JUST_OVER, startedAt: null }, NOW)).toBe("STALLED");
    expect(deriveDocumentStatus({ status: "RUNNING", requestedAt: JUST_OVER, startedAt: JUST_OVER }, NOW)).toBe("STALLED");
  });
});

describe("safeExtractionErrorMessage", () => {
  it("maps every AIProviderErrorCode to a safe, non-raw string", () => {
    expect(safeExtractionErrorMessage("PROVIDER_REQUEST_FAILED")).toMatch(/extraction service/i);
    expect(safeExtractionErrorMessage("EMPTY_RESPONSE")).toMatch(/extraction service/i);
    expect(safeExtractionErrorMessage("INVALID_JSON")).toMatch(/extraction service/i);
    expect(safeExtractionErrorMessage("SCHEMA_VALIDATION_FAILED")).toMatch(/extraction service/i);
  });

  it("maps TIMED_OUT to a stale-specific message", () => {
    expect(safeExtractionErrorMessage("TIMED_OUT")).toMatch(/didn't respond in time/i);
  });

  it("falls back to a generic message for an unmapped/unknown code", () => {
    expect(safeExtractionErrorMessage("UNKNOWN")).toMatch(/unknown reason/i);
    expect(safeExtractionErrorMessage(null)).toMatch(/unknown reason/i);
  });
});
