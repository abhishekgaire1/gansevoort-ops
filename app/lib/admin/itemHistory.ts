import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Item workspace History section (spec section 3) -- every audit_events
 * row for this item (CANONICAL_ITEM_*, VENDOR_PACKAGE_CONFIGURED via its
 * own entity_type, INVENTORY_CORRECTION_RECORDED) plus every
 * inventory_corrections row for this item, merged into one newest-first
 * timeline. Actor names resolved via the same app_users -> employees
 * batch-join pattern already used by getReceiptHistory.ts -- never a
 * separate ad-hoc lookup.
 */
export interface ItemHistoryEntry {
  id: string;
  occurredAt: string;
  actorName: string | null;
  action: string;
  reason: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
}

export async function listItemHistory(supabase: SupabaseClient, organizationId: string, itemId: string): Promise<ItemHistoryEntry[]> {
  // INVENTORY_CORRECTION_RECORDED is excluded here -- it's written to
  // audit_events by record_inventory_correction/correct_receipt_package_
  // factor for the org-wide audit convention, but inventory_corrections
  // below already carries the identical event with richer fields
  // (reason, previous/new quantity, delta) -- showing both would be a
  // duplicate entry for the same real-world action.
  const { data: auditRows } = await supabase
    .from("audit_events")
    .select("id, occurred_at, actor_app_user_id, action, before_state, after_state")
    .eq("organization_id", organizationId)
    .eq("entity_type", "inventory_item")
    .eq("entity_id", itemId)
    .neq("action", "INVENTORY_CORRECTION_RECORDED")
    .order("occurred_at", { ascending: false });

  // VENDOR_PACKAGE_CONFIGURED audit rows are keyed to entity_type =
  // 'vendor_item_purchase_unit' with entity_id = the package version's
  // own id (see 20260811100120's insert) -- never entity_type =
  // 'inventory_item' -- so they can't be picked up by the query above.
  // Resolve this item's package version ids first, then pull their
  // audit rows separately.
  const { data: packageVersionRows } = await supabase.from("vendor_item_purchase_units").select("id").eq("organization_id", organizationId).eq("inventory_item_id", itemId);
  const packageVersionIds = (packageVersionRows ?? []).map((r) => r.id as string);
  const { data: packageAuditRows } =
    packageVersionIds.length > 0
      ? await supabase
          .from("audit_events")
          .select("id, occurred_at, actor_app_user_id, action, before_state, after_state")
          .eq("organization_id", organizationId)
          .eq("entity_type", "vendor_item_purchase_unit")
          .in("entity_id", packageVersionIds)
          .order("occurred_at", { ascending: false })
      : { data: [] };

  const { data: correctionRows } = await supabase
    .from("inventory_corrections")
    .select("id, created_at, performed_by_app_user_id, correction_type, reason, previous_quantity, new_quantity, quantity_delta")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", itemId)
    .order("created_at", { ascending: false });

  const actorIds = new Set<string>();
  for (const r of auditRows ?? []) if (r.actor_app_user_id) actorIds.add(r.actor_app_user_id as string);
  for (const r of packageAuditRows ?? []) if (r.actor_app_user_id) actorIds.add(r.actor_app_user_id as string);
  for (const r of correctionRows ?? []) if (r.performed_by_app_user_id) actorIds.add(r.performed_by_app_user_id as string);

  const { data: appUsers } =
    actorIds.size > 0 ? await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", Array.from(actorIds)) : { data: [] };
  const nameById = new Map(
    (appUsers ?? []).map((row) => {
      const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
      return [row.id as string, employee ? `${employee.first_name} ${employee.last_name}` : null];
    })
  );

  const auditEntries: ItemHistoryEntry[] = [...(auditRows ?? []), ...(packageAuditRows ?? [])].map((r) => ({
    id: r.id as string,
    occurredAt: r.occurred_at as string,
    actorName: r.actor_app_user_id ? (nameById.get(r.actor_app_user_id as string) ?? null) : null,
    action: r.action as string,
    reason: null,
    beforeState: (r.before_state as Record<string, unknown> | null) ?? null,
    afterState: (r.after_state as Record<string, unknown> | null) ?? null,
  }));

  const correctionEntries: ItemHistoryEntry[] = (correctionRows ?? []).map((r) => ({
    id: r.id as string,
    occurredAt: r.created_at as string,
    actorName: r.performed_by_app_user_id ? (nameById.get(r.performed_by_app_user_id as string) ?? null) : null,
    action: r.correction_type === "MANUAL_ADJUSTMENT" ? "INVENTORY_ADJUSTED" : "RECEIPT_PACKAGE_FACTOR_CORRECTED",
    reason: r.reason as string,
    beforeState: { quantity: r.previous_quantity },
    afterState: { quantity: r.new_quantity, delta: r.quantity_delta },
  }));

  return [...auditEntries, ...correctionEntries].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
}
