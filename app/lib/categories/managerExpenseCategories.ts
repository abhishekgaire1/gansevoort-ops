import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Manager Categories milestone -- Expense Category list/detail read
 * model. Inclusion rule (Phase A inspection, see the migration's own
 * comment): purchase_documents.status = 'VERIFIED' AND line
 * classification status = 'CONFIRMED' AND disposition = 'NON_INVENTORY'.
 * CREDIT_MEMO lines are excluded, not sign-flipped -- no negative-amount
 * semantics exist anywhere in this schema (Part 27).
 */

export interface ManagerExpenseCategorySummary {
  categoryId: string;
  name: string;
  totalAmount: number;
  lineCount: number;
  excludedCreditMemoCount: number;
}

/** ONE aggregate RPC call for every category's totals in the given period
 * -- never one query per category (Part 43). */
export async function listManagerExpenseCategories(
  supabase: SupabaseClient,
  organizationId: string,
  startDate: string,
  endDate: string
): Promise<ManagerExpenseCategorySummary[]> {
  const [{ data: categories, error: catError }, { data: totalRows, error: totalError }] = await Promise.all([
    supabase.from("spend_categories").select("id, name").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.rpc("get_expense_category_totals", { p_organization_id: organizationId, p_start_date: startDate, p_end_date: endDate }),
  ]);
  if (catError) throw new Error(catError.message);
  if (totalError) throw new Error(totalError.message);

  const totalsByCategoryId = new Map(
    ((totalRows ?? []) as { out_category_id: string; out_total_amount: number; out_line_count: number; out_excluded_credit_memo_count: number }[]).map((r) => [
      r.out_category_id,
      { totalAmount: Number(r.out_total_amount), lineCount: Number(r.out_line_count), excludedCreditMemoCount: Number(r.out_excluded_credit_memo_count) },
    ])
  );

  return (categories ?? []).map((c) => {
    const totals = totalsByCategoryId.get(c.id as string);
    return {
      categoryId: c.id as string,
      name: c.name as string,
      totalAmount: totals?.totalAmount ?? 0,
      lineCount: totals?.lineCount ?? 0,
      excludedCreditMemoCount: totals?.excludedCreditMemoCount ?? 0,
    };
  });
}

export interface ManagerExpenseCategoryDetail {
  categoryId: string;
  name: string;
  isActive: boolean;
}

export async function getManagerExpenseCategory(supabase: SupabaseClient, organizationId: string, categoryId: string): Promise<ManagerExpenseCategoryDetail | null> {
  const { data, error } = await supabase.from("spend_categories").select("id, name, is_active").eq("organization_id", organizationId).eq("id", categoryId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { categoryId: data.id as string, name: data.name as string, isActive: data.is_active as boolean };
}

export interface ManagerExpenseCategorySummaryDetail {
  totalAmount: number;
  lineCount: number;
  excludedCreditMemoCount: number;
}

export async function getManagerExpenseCategorySummary(
  supabase: SupabaseClient,
  organizationId: string,
  categoryId: string,
  startDate: string,
  endDate: string
): Promise<ManagerExpenseCategorySummaryDetail> {
  const { data, error } = await supabase.rpc("get_expense_category_summary", {
    p_organization_id: organizationId,
    p_category_id: categoryId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { out_total_amount: number; out_line_count: number; out_excluded_credit_memo_count: number } | undefined;
  return {
    totalAmount: Number(row?.out_total_amount ?? 0),
    lineCount: Number(row?.out_line_count ?? 0),
    excludedCreditMemoCount: Number(row?.out_excluded_credit_memo_count ?? 0),
  };
}

export interface ManagerExpenseCategoryLine {
  lineId: string;
  description: string | null;
  lineTotal: number | null;
  documentId: string;
  documentNumber: string | null;
  documentType: string | null;
  documentDate: string | null;
  vendorName: string | null;
}

export async function listManagerExpenseCategoryLines(
  supabase: SupabaseClient,
  organizationId: string,
  categoryId: string,
  startDate: string,
  endDate: string,
  limit: number,
  offset: number
): Promise<ManagerExpenseCategoryLine[]> {
  const { data, error } = await supabase.rpc("get_expense_category_lines", {
    p_organization_id: organizationId,
    p_category_id: categoryId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);

  return (
    (data ?? []) as {
      out_line_id: string;
      out_description: string | null;
      out_line_total: number | null;
      out_document_id: string;
      out_document_number: string | null;
      out_document_type: string | null;
      out_document_date: string | null;
      out_vendor_name: string | null;
    }[]
  ).map((r) => ({
    lineId: r.out_line_id,
    description: r.out_description,
    lineTotal: r.out_line_total === null ? null : Number(r.out_line_total),
    documentId: r.out_document_id,
    documentNumber: r.out_document_number,
    documentType: r.out_document_type,
    documentDate: r.out_document_date,
    vendorName: r.out_vendor_name,
  }));
}
