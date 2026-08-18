import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLinesNeedingClassification } from "@/app/lib/itemMaster/getLinesNeedingClassification";

// CI-safe: no network, no database -- proves the corrected set-based
// "needs classification" signal is NOT a count comparison (plan §4): an
// orphaned classification row (whose line_key no longer matches any
// current line) must never mask a genuinely new, unclassified current
// line, even when doing so makes the two table sizes equal.

function fakeSupabase(lines: Record<string, unknown>[], classifications: Record<string, unknown>[]) {
  const from = vi.fn((table: string) => {
    if (table === "purchase_document_lines") {
      return { select: () => ({ eq: () => Promise.resolve({ data: lines, error: null }) }) };
    }
    if (table === "purchase_document_line_classifications") {
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: classifications, error: null }) }) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { from } as unknown as SupabaseClient;
}

const LINE_1 = { line_key: "line-1", vendor_sku: "SKU-1", description: "Chicken Thigh", package_unit: "CS", measured_unit: "LB" };
const LINE_2 = { line_key: "line-2", vendor_sku: "SKU-2", description: "Eggs", package_unit: "CS", measured_unit: "EA" };

describe("getLinesNeedingClassification", () => {
  it("flags a current line with no classification row at all", async () => {
    const supabase = fakeSupabase([LINE_1], []);
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result.map((l) => l.lineKey)).toEqual(["line-1"]);
  });

  it("flags a current line whose classification is STALE", async () => {
    const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "STALE" }]);
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result.map((l) => l.lineKey)).toEqual(["line-1"]);
  });

  it("does not flag a CONFIRMED line", async () => {
    const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "CONFIRMED" }]);
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result).toEqual([]);
  });

  it("does not flag a PENDING_REVIEW line -- it is correctly awaiting manager approval, not stuck", async () => {
    const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "PENDING_REVIEW" }]);
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result).toEqual([]);
  });

  it("is never fooled by an orphaned classification row inflating the count to equal the line count", async () => {
    // One CONFIRMED line (line-1), one orphaned classification row for a
    // line_key that no longer matches any CURRENT line (e.g. a line
    // removed by a later save), and one genuinely new, never-classified
    // current line (line-2). A naive "line count > classification count"
    // check would see 2 lines vs 2 classification rows and conclude
    // nothing needs classification -- exactly the bug this signal fixes.
    const supabase = fakeSupabase(
      [LINE_1, LINE_2],
      [
        { line_key: "line-1", status: "CONFIRMED" },
        { line_key: "orphaned-line-key-no-longer-current", status: "CONFIRMED" },
      ]
    );
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result.map((l) => l.lineKey)).toEqual(["line-2"]);
  });

  it("returns an empty array when every current line is fully resolved", async () => {
    const supabase = fakeSupabase(
      [LINE_1, LINE_2],
      [
        { line_key: "line-1", status: "CONFIRMED" },
        { line_key: "line-2", status: "PENDING_REVIEW" },
      ]
    );
    const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
    expect(result).toEqual([]);
  });

  describe("includeUnconfirmedAiProposals (the manual 'Run Item Matching' refresh opt-in)", () => {
    it("flags an unconfirmed AI-suggested PENDING_REVIEW line only when explicitly opted in", async () => {
      const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "PENDING_REVIEW", resolution_source: "AI_SUGGESTED" }]);

      const withoutOption = await getLinesNeedingClassification(supabase, "pd-1", "org-1");
      expect(withoutOption).toEqual([]);

      const withOption = await getLinesNeedingClassification(supabase, "pd-1", "org-1", { includeUnconfirmedAiProposals: true });
      expect(withOption.map((l) => l.lineKey)).toEqual(["line-1"]);
    });

    it("never flags a CONFIRMED line, even with the option set", async () => {
      const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "CONFIRMED", resolution_source: "MANUAL" }]);
      const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1", { includeUnconfirmedAiProposals: true });
      expect(result).toEqual([]);
    });

    it("does not flag a PENDING_REVIEW line whose resolution source is not AI_SUGGESTED, even with the option set", async () => {
      const supabase = fakeSupabase([LINE_1], [{ line_key: "line-1", status: "PENDING_REVIEW", resolution_source: "MANUAL" }]);
      const result = await getLinesNeedingClassification(supabase, "pd-1", "org-1", { includeUnconfirmedAiProposals: true });
      expect(result).toEqual([]);
    });
  });
});
