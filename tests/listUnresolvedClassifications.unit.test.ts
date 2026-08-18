import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listUnresolvedClassifications } from "@/app/lib/itemMaster/listUnresolvedClassifications";

// CI-safe: no network, no database -- proves the org-wide recovery queue
// (behind /manager/items/review) applies the exact same set-based
// "still current" check as getLinesNeedingClassification, just across
// every purchase document instead of one: an orphaned classification row
// (line_key no longer matching any current line on ITS OWN document) and
// a classification belonging to a DISCARDED document must both be
// excluded, never just the CONFIRMED/PENDING_REVIEW status filter alone.

interface Fixture {
  classifications: Record<string, unknown>[];
  purchaseDocuments: Record<string, unknown>[];
  lines: Record<string, unknown>[];
  vendors?: Record<string, unknown>[];
  items?: Record<string, unknown>[];
}

function fakeSupabase(fx: Fixture) {
  const from = vi.fn((table: string) => {
    if (table === "purchase_document_line_classifications") {
      return { select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: fx.classifications, error: null }) }) }) };
    }
    if (table === "purchase_documents") {
      return { select: () => ({ in: () => ({ eq: () => ({ neq: () => Promise.resolve({ data: fx.purchaseDocuments, error: null }) }) }) }) };
    }
    if (table === "purchase_document_lines") {
      return { select: () => ({ in: () => Promise.resolve({ data: fx.lines, error: null }) }) };
    }
    if (table === "vendors") {
      return { select: () => ({ in: () => Promise.resolve({ data: fx.vendors ?? [], error: null }) }) };
    }
    if (table === "inventory_items") {
      return { select: () => ({ in: () => Promise.resolve({ data: fx.items ?? [], error: null }) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { from } as unknown as SupabaseClient;
}

describe("listUnresolvedClassifications", () => {
  it("returns nothing when there are no PENDING_REVIEW/STALE rows", async () => {
    const supabase = fakeSupabase({ classifications: [], purchaseDocuments: [], lines: [] });
    const result = await listUnresolvedClassifications(supabase, "org-1");
    expect(result).toEqual([]);
  });

  it("includes a PENDING_REVIEW row whose line_key is still current", async () => {
    const supabase = fakeSupabase({
      classifications: [{ id: "c1", purchase_document_id: "pd-1", line_key: "line-1", status: "PENDING_REVIEW", resolution_source: "AI_SUGGESTED", ai_confidence: 0.8, inventory_item_id: null, ai_suggested_inventory_item_id: "item-1" }],
      purchaseDocuments: [{ id: "pd-1", document_number: "INV-1", vendor_id: "vendor-1", status: "READY_FOR_VERIFICATION" }],
      lines: [{ purchase_document_id: "pd-1", line_key: "line-1", vendor_sku: "SKU-1", description: "Widget" }],
      vendors: [{ id: "vendor-1", name: "Acme" }],
      items: [{ id: "item-1", name: "Proposed Widget", approval_status: "PENDING_REVIEW" }],
    });
    const result = await listUnresolvedClassifications(supabase, "org-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      classificationId: "c1",
      purchaseDocumentId: "pd-1",
      documentNumber: "INV-1",
      vendorName: "Acme",
      lineKey: "line-1",
      status: "PENDING_REVIEW",
      aiSuggestedInventoryItemName: "Proposed Widget",
      aiSuggestedIsNewProposal: true,
    });
  });

  it("excludes an orphaned classification row whose line_key no longer matches any current line", async () => {
    const supabase = fakeSupabase({
      classifications: [{ id: "c1", purchase_document_id: "pd-1", line_key: "orphaned-line-key", status: "STALE", resolution_source: "MANUAL", ai_confidence: null, inventory_item_id: "item-1", ai_suggested_inventory_item_id: null }],
      purchaseDocuments: [{ id: "pd-1", document_number: "INV-1", vendor_id: "vendor-1", status: "VERIFIED" }],
      lines: [{ purchase_document_id: "pd-1", line_key: "a-different-current-line-key", vendor_sku: "SKU-2", description: "Something Else" }],
    });
    const result = await listUnresolvedClassifications(supabase, "org-1");
    expect(result).toEqual([]);
  });

  it("excludes a classification belonging to a DISCARDED purchase document", async () => {
    const supabase = fakeSupabase({
      classifications: [{ id: "c1", purchase_document_id: "pd-1", line_key: "line-1", status: "PENDING_REVIEW", resolution_source: "AI_SUGGESTED", ai_confidence: 0.5, inventory_item_id: null, ai_suggested_inventory_item_id: "item-1" }],
      // The purchase_documents query itself filters out DISCARDED (neq),
      // so a discarded document's row is simply absent from this result.
      purchaseDocuments: [],
      lines: [{ purchase_document_id: "pd-1", line_key: "line-1", vendor_sku: "SKU-1", description: "Widget" }],
    });
    const result = await listUnresolvedClassifications(supabase, "org-1");
    expect(result).toEqual([]);
  });

  it("marks an AI-suggested candidate pointing at an existing CONFIRMED item as not a new proposal", async () => {
    const supabase = fakeSupabase({
      classifications: [{ id: "c1", purchase_document_id: "pd-1", line_key: "line-1", status: "PENDING_REVIEW", resolution_source: "AI_SUGGESTED", ai_confidence: 0.9, inventory_item_id: null, ai_suggested_inventory_item_id: "item-1" }],
      purchaseDocuments: [{ id: "pd-1", document_number: "INV-1", vendor_id: null, status: "VERIFIED" }],
      lines: [{ purchase_document_id: "pd-1", line_key: "line-1", vendor_sku: "SKU-1", description: "Widget" }],
      items: [{ id: "item-1", name: "Existing Widget", approval_status: "CONFIRMED" }],
    });
    const result = await listUnresolvedClassifications(supabase, "org-1");
    expect(result[0]).toMatchObject({ aiSuggestedInventoryItemName: "Existing Widget", aiSuggestedIsNewProposal: false });
  });
});
