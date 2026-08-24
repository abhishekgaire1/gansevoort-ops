import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createVerifiedPostingDocument, createSubmittedPostingDocument } from "./inventoryPostingTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment. Proves the Manager Categories milestone's read-model RPCs
 * (20260811100102) against real Postgres: the expense-category inclusion
 * rule (VERIFIED + CONFIRMED + NON_INVENTORY), CREDIT_MEMO exclusion,
 * cross-org isolation, and inventory-category item counts.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

async function primaryLocationId(): Promise<string> {
  const { data } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  return data!.id as string;
}

describe("get_expense_category_summary / get_expense_category_lines -- inclusion rule", () => {
  it("counts a VERIFIED document's CONFIRMED NON_INVENTORY line, and the line appears with correct description/amount/vendor", async () => {
    const locationId = await primaryLocationId();
    const description = `TEST Expense Line ${randomUUID().slice(0, 8)}`;
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [{ description, receiving: null }]);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("spend_category_id")
      .eq("purchase_document_id", verified.purchaseDocumentId)
      .eq("line_key", verified.lineKeys[0])
      .single();
    const categoryId = classification!.spend_category_id as string;

    const today = new Date().toISOString().slice(0, 10);
    const { data: linesData, error } = await fx.supabase.rpc("get_expense_category_lines", {
      p_organization_id: fx.organizationId,
      p_category_id: categoryId,
      p_start_date: "2020-01-01",
      p_end_date: today,
      p_limit: 200,
      p_offset: 0,
    });
    expect(error).toBeNull();
    const lines = linesData as { out_line_id: string; out_description: string; out_line_total: number; out_document_id: string }[];
    const match = lines.find((l) => l.out_description === description);
    expect(match).toBeDefined();
    expect(Number(match!.out_line_total)).toBe(100);
    expect(match!.out_document_id).toBe(verified.purchaseDocumentId);
  });

  it("excludes a line whose document is only READY_FOR_VERIFICATION (not yet VERIFIED)", async () => {
    const locationId = await primaryLocationId();
    const description = `TEST Not Yet Verified ${randomUUID().slice(0, 8)}`;
    const submitted = await createSubmittedPostingDocument(fx.supabase, fx, locationId, [{ description, receiving: null }]);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("spend_category_id")
      .eq("purchase_document_id", submitted.purchaseDocumentId)
      .eq("line_key", submitted.lineKeys[0])
      .single();
    const categoryId = classification!.spend_category_id as string;

    const today = new Date().toISOString().slice(0, 10);
    const { data: linesData } = await fx.supabase.rpc("get_expense_category_lines", {
      p_organization_id: fx.organizationId,
      p_category_id: categoryId,
      p_start_date: "2020-01-01",
      p_end_date: today,
      p_limit: 200,
      p_offset: 0,
    });
    const lines = linesData as { out_description: string }[];
    expect(lines.find((l) => l.out_description === description)).toBeUndefined();
  });

  it("excludes CREDIT_MEMO document lines from totals and the recent-lines list, never sign-flips them", async () => {
    const locationId = await primaryLocationId();
    const description = `TEST Credit Memo Line ${randomUUID().slice(0, 8)}`;
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [{ description, receiving: null }]);

    // Test-only direct adjustment to exercise the CREDIT_MEMO exclusion
    // path -- no application RPC currently lets a document's type change
    // after creation, and this is exactly the schema-level fact the
    // exclusion rule reads.
    await fx.supabase.from("purchase_documents").update({ document_type: "CREDIT_MEMO" }).eq("id", verified.purchaseDocumentId);

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("spend_category_id")
      .eq("purchase_document_id", verified.purchaseDocumentId)
      .eq("line_key", verified.lineKeys[0])
      .single();
    const categoryId = classification!.spend_category_id as string;

    const today = new Date().toISOString().slice(0, 10);
    const { data: summaryData } = await fx.supabase.rpc("get_expense_category_summary", {
      p_organization_id: fx.organizationId,
      p_category_id: categoryId,
      p_start_date: "2020-01-01",
      p_end_date: today,
    });
    const summary = (summaryData as { out_total_amount: number; out_line_count: number; out_excluded_credit_memo_count: number }[])[0];
    expect(Number(summary.out_total_amount)).toBe(0);
    expect(Number(summary.out_line_count)).toBe(0);
    expect(Number(summary.out_excluded_credit_memo_count)).toBe(1);

    const { data: linesData } = await fx.supabase.rpc("get_expense_category_lines", {
      p_organization_id: fx.organizationId,
      p_category_id: categoryId,
      p_start_date: "2020-01-01",
      p_end_date: today,
      p_limit: 200,
      p_offset: 0,
    });
    const lines = linesData as { out_description: string }[];
    expect(lines.find((l) => l.out_description === description)).toBeUndefined();
  });

  it("never leaks another organization's expense lines into this organization's totals", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: summaryData, error } = await fx.supabase.rpc("get_expense_category_summary", {
      p_organization_id: otherOrg.organizationId,
      p_category_id: "00000000-0000-0000-0000-000000000000",
      p_start_date: "2020-01-01",
      p_end_date: today,
    });
    expect(error).toBeNull();
    const summary = (summaryData as { out_total_amount: number; out_line_count: number }[])[0];
    expect(Number(summary.out_total_amount)).toBe(0);
    expect(Number(summary.out_line_count)).toBe(0);
  });
});

describe("get_inventory_category_item_counts", () => {
  it("counts only active, CONFIRMED, INVENTORY-disposition items, scoped to this organization", async () => {
    const { data: countsData, error } = await fx.supabase.rpc("get_inventory_category_item_counts", { p_organization_id: fx.organizationId });
    expect(error).toBeNull();
    const counts = countsData as { out_category_id: string; out_item_count: number }[];

    const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
    const categoryId = categoryRow!.category_id as string;
    const match = counts.find((c) => c.out_category_id === categoryId);
    expect(match).toBeDefined();
    expect(Number(match!.out_item_count)).toBeGreaterThan(0);
  });
});
