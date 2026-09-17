import { describe, expect, it } from "vitest";
import {
  classifyPriorUpload,
  isSupersededPriorUpload,
  duplicateUploadNotice,
  PRIOR_STATE_SIGNIFICANCE,
  type PriorUploadState,
} from "@/app/lib/documents/priorUploadState";

/**
 * The upload "possible duplicate" prompt is state-aware: it warns strongly
 * for a live/verified prior upload of the same file, but only softly (an
 * FYI) for one the manager already discarded or removed.
 */

describe("classifyPriorUpload", () => {
  it("a removed/archived upload is REMOVED regardless of its drafts", () => {
    expect(classifyPriorUpload({ archived: true, purchaseDocumentStatuses: [] })).toBe("REMOVED");
    expect(classifyPriorUpload({ archived: true, purchaseDocumentStatuses: ["VERIFIED"] })).toBe("REMOVED");
  });

  it("picks the most significant live status when several revisions exist", () => {
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: ["DISCARDED", "VERIFIED"] })).toBe("VERIFIED");
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: ["DISCARDED", "READY_FOR_VERIFICATION"] })).toBe("READY_FOR_VERIFICATION");
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: ["DISCARDED", "DRAFT"] })).toBe("DRAFT");
  });

  it("is DISCARDED when every revision is discarded (the reported case), IN_PROGRESS when no draft exists yet", () => {
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: ["DISCARDED"] })).toBe("DISCARDED");
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: ["DISCARDED", "DISCARDED"] })).toBe("DISCARDED");
    expect(classifyPriorUpload({ archived: false, purchaseDocumentStatuses: [] })).toBe("IN_PROGRESS");
  });
});

describe("isSupersededPriorUpload", () => {
  it("only DISCARDED and REMOVED are superseded", () => {
    const superseded: PriorUploadState[] = ["DISCARDED", "REMOVED"];
    const live: PriorUploadState[] = ["IN_PROGRESS", "DRAFT", "READY_FOR_VERIFICATION", "VERIFIED"];
    for (const s of superseded) expect(isSupersededPriorUpload(s)).toBe(true);
    for (const s of live) expect(isSupersededPriorUpload(s)).toBe(false);
  });
});

describe("PRIOR_STATE_SIGNIFICANCE", () => {
  it("ranks a verified prior above a discarded/removed one so a live duplicate is never hidden", () => {
    expect(PRIOR_STATE_SIGNIFICANCE.VERIFIED).toBeGreaterThan(PRIOR_STATE_SIGNIFICANCE.DISCARDED);
    expect(PRIOR_STATE_SIGNIFICANCE.DRAFT).toBeGreaterThan(PRIOR_STATE_SIGNIFICANCE.REMOVED);
    expect(PRIOR_STATE_SIGNIFICANCE.IN_PROGRESS).toBeGreaterThan(PRIOR_STATE_SIGNIFICANCE.DISCARDED);
  });
});

describe("duplicateUploadNotice", () => {
  it("live priors get a warning tone, keep Open Existing, and say 'Upload Anyway'", () => {
    for (const s of ["VERIFIED", "READY_FOR_VERIFICATION", "DRAFT", "IN_PROGRESS"] as PriorUploadState[]) {
      const n = duplicateUploadNotice(s, "9/17/2026, 10:25:06 AM");
      expect(n.tone).toBe("warning");
      expect(n.showOpenExisting).toBe(true);
      expect(n.proceedLabel).toBe("Upload Anyway");
      expect(n.message).toContain("9/17/2026, 10:25:06 AM");
    }
  });

  it("the verified prior is called out as already verified (double-post risk)", () => {
    expect(duplicateUploadNotice("VERIFIED", "DATE").message).toMatch(/verified/i);
  });

  it("superseded priors get an info tone, hide Open Existing, and read as an FYI (the reported discarded case)", () => {
    const discarded = duplicateUploadNotice("DISCARDED", "9/17/2026, 10:25:06 AM");
    expect(discarded.tone).toBe("info");
    expect(discarded.showOpenExisting).toBe(false);
    expect(discarded.proceedLabel).toBe("Continue Upload");
    expect(discarded.message).toMatch(/discarded/i);

    const removed = duplicateUploadNotice("REMOVED", "DATE");
    expect(removed.tone).toBe("info");
    expect(removed.showOpenExisting).toBe(false);
    expect(removed.message).toMatch(/removed/i);
  });
});
