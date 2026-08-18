import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type InventoryPostingStatus = "NOT_POSTED" | "PARTIALLY_POSTED" | "POSTED";

export interface InventoryPostingDetailLine {
  itemName: string | null;
  postedBaseQuantity: number;
  baseUnitCode: string | null;
  locationName: string | null;
  movementId: string;
}

export interface InventoryPostingRecord {
  postingId: string;
  postedAt: string;
  postedByName: string | null;
  lines: InventoryPostingDetailLine[];
}

export interface InventoryPostingDetail {
  status: InventoryPostingStatus;
  requiredLineCount: number;
  postedLineCount: number;
  postings: InventoryPostingRecord[];
}

/**
 * The VERIFIED page's Inventory Posting section read model -- status is
 * derived by purchase_document_inventory_posting_status (actual posting
 * records vs required effective inventory lines, NEVER document status or
 * receipt existence), and the detail rows come from the posting tables
 * themselves, joined to items/units/locations/actor names.
 */
export async function getInventoryPostingDetail(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<InventoryPostingDetail> {
  const { data: statusRows, error: statusError } = await supabase.rpc("purchase_document_inventory_posting_status", {
    p_purchase_document_id: purchaseDocumentId,
    p_organization_id: organizationId,
  });
  if (statusError) throw new Error(statusError.message);
  const statusRow = (Array.isArray(statusRows) ? statusRows[0] : statusRows) as
    | { out_status: string; out_required_line_count: number; out_posted_line_count: number }
    | undefined;

  const { data: postings } = await supabase
    .from("purchase_document_inventory_postings")
    .select("id, posted_at, posted_by_app_user_id")
    .eq("organization_id", organizationId)
    .eq("purchase_document_id", purchaseDocumentId)
    .order("posted_at", { ascending: true });

  const postingIds = (postings ?? []).map((p) => p.id as string);
  const { data: lines } =
    postingIds.length > 0
      ? await supabase
          .from("purchase_document_inventory_posting_lines")
          .select("posting_id, movement_id, posted_base_quantity, inventory_items(name), units(code), locations(name)")
          .in("posting_id", postingIds)
          .order("created_at", { ascending: true })
      : { data: [] };

  const actorIds = Array.from(new Set((postings ?? []).map((p) => p.posted_by_app_user_id as string)));
  const { data: actors } =
    actorIds.length > 0 ? await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", actorIds) : { data: [] };
  const actorNameById = new Map(
    (actors ?? []).map((row) => {
      const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
      return [row.id as string, employee ? `${employee.first_name} ${employee.last_name}` : null];
    })
  );

  const linesByPostingId = new Map<string, InventoryPostingDetailLine[]>();
  for (const line of lines ?? []) {
    const postingId = line.posting_id as string;
    const item = Array.isArray(line.inventory_items) ? line.inventory_items[0] : line.inventory_items;
    const unit = Array.isArray(line.units) ? line.units[0] : line.units;
    const location = Array.isArray(line.locations) ? line.locations[0] : line.locations;
    if (!linesByPostingId.has(postingId)) linesByPostingId.set(postingId, []);
    linesByPostingId.get(postingId)!.push({
      itemName: (item?.name as string | undefined) ?? null,
      postedBaseQuantity: line.posted_base_quantity as number,
      baseUnitCode: (unit?.code as string | undefined) ?? null,
      locationName: (location?.name as string | undefined) ?? null,
      movementId: line.movement_id as string,
    });
  }

  return {
    status: (statusRow?.out_status as InventoryPostingStatus | undefined) ?? "NOT_POSTED",
    requiredLineCount: statusRow?.out_required_line_count ?? 0,
    postedLineCount: statusRow?.out_posted_line_count ?? 0,
    postings: (postings ?? []).map((p) => ({
      postingId: p.id as string,
      postedAt: p.posted_at as string,
      postedByName: actorNameById.get(p.posted_by_app_user_id as string) ?? null,
      lines: linesByPostingId.get(p.id as string) ?? [],
    })),
  };
}
