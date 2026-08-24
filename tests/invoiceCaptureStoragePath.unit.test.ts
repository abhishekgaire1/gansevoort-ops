import { describe, expect, it } from "vitest";
import { buildCaptureStoragePath, RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/invoiceCapture/storagePath";
import { RECEIVING_DOCUMENTS_BUCKET as DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

// CI-safe: no network, no database. Proves capture evidence lands in a
// path prefix that can never collide with the existing, authoritative
// org/<org>/documents/<id>/ prefix (Part 33) -- and that no second Storage
// bucket was introduced (buckets in this project are created manually via
// the Supabase Dashboard, never via migration).

describe("buildCaptureStoragePath", () => {
  it("reuses the SAME bucket as the existing document pipeline, not a new one", () => {
    expect(RECEIVING_DOCUMENTS_BUCKET).toBe(DOCUMENTS_BUCKET);
  });

  it("builds a path clearly distinct from org/<org>/documents/<id>/ -- under a captures/ prefix", () => {
    const path = buildCaptureStoragePath("org-1", "session-1", 1, "jpg");
    expect(path).toBe("org/org-1/captures/session-1/page-1.jpg");
    expect(path).not.toContain("/documents/");
  });

  it("scopes the path to the exact page number and extension supplied", () => {
    expect(buildCaptureStoragePath("org-1", "session-1", 1, "png")).toBe("org/org-1/captures/session-1/page-1.png");
    expect(buildCaptureStoragePath("org-1", "session-1", 2, "jpg")).toBe("org/org-1/captures/session-1/page-2.jpg");
  });

  it("keeps two different sessions in the same org fully isolated from each other", () => {
    const a = buildCaptureStoragePath("org-1", "session-A", 1, "jpg");
    const b = buildCaptureStoragePath("org-1", "session-B", 1, "jpg");
    expect(a).not.toBe(b);
  });

  it("keeps two different organizations fully isolated from each other", () => {
    const a = buildCaptureStoragePath("org-1", "session-1", 1, "jpg");
    const b = buildCaptureStoragePath("org-2", "session-1", 1, "jpg");
    expect(a).not.toBe(b);
  });
});
