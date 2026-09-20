import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * §4 posted-delivery-conflict handoff read model.
 *
 * When an ambiguous (duplicate-lineage) document was ALREADY posted, the
 * append-only resolver refuses to auto-resolve (resolve_delivery_lineage returns
 * status ALREADY_POSTED / routed_to_correction) because inventory has already
 * moved. The excess must instead be removed through the audited inventory
 * correction primitive (record_inventory_correction, 20260811100141), never by
 * mutating history.
 *
 * This read model computes, per (inventory item, location), exactly how much was
 * posted, how much SHOULD have been posted if the duplicate lineages collapsed
 * to a single retained delivery, the resulting excess, the current on-hand, the
 * proposed correction delta, and whether that delta would drive stock negative.
 * It applies ONLY to a document that is already posted with duplicate lineages;
 * it never itself writes anything.
 */

export interface PostedDeliveryConflictItem {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  baseUnitCode: string;
  /** How many distinct effective delivery lineages fed this (item, location). */
  lineageCount: number;
  /** Base quantity actually added by posting (sum of all duplicate lineages). */
  postedBaseQuantity: number;
  /** What a single retained lineage would have added (posted / lineageCount). */
  intendedBaseQuantity: number;
  /** postedBaseQuantity - intendedBaseQuantity: the duplicate excess to remove. */
  excessBaseQuantity: number;
  /** Current authoritative on-hand for this (item, location). */
  currentOnHand: number;
  /** DELTA the correction would apply: -excessBaseQuantity. */
  proposedDelta: number;
  /** currentOnHand + proposedDelta, i.e. on-hand after correction. */
  proposedOnHand: number;
  /** True when removing the excess would drive on-hand below zero. */
  wouldGoNegative: boolean;
}

export interface PostedDeliveryConflict {
  purchaseDocumentId: string;
  isPostedConflict: boolean;
  postingIds: string[];
  postedAt: string | null;
  movementIds: string[];
  items: PostedDeliveryConflictItem[];
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export async function getPostedDeliveryConflict(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string,
): Promise<PostedDeliveryConflict> {
  const empty: PostedDeliveryConflict = {
    purchaseDocumentId,
    isPostedConflict: false,
    postingIds: [],
    postedAt: null,
    movementIds: [],
    items: [],
  };

  // The conflict handoff exists only for an ALREADY-posted document whose
  // effective lineage is ambiguous (the same physical delivery recorded more
  // than once). Genuine additional deliveries (distinct delivery_event_id) are
  // not duplicates and never routed here.
  const [{ data: status }, { data: postings }] = await Promise.all([
    supabase.rpc("purchase_document_delivery_status", { p_purchase_document_id: purchaseDocumentId, p_organization_id: organizationId }),
    supabase
      .from("purchase_document_inventory_postings")
      .select("id, created_at")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", organizationId),
  ]);

  const postingRows = (postings ?? []) as { id: string; created_at: string | null }[];
  if (postingRows.length === 0) return empty;

  // AMBIGUOUS means an unresolved duplicate lineage; RESOLVED-but-posted with a
  // stale posting can also carry excess, but only AMBIGUOUS produces duplicate
  // inventory that must be corrected. Anything else has no excess to remove.
  if ((status as string) !== "AMBIGUOUS") return empty;

  const postingIds = postingRows.map((p) => p.id);
  const { data: lines } = await supabase
    .from("purchase_document_inventory_posting_lines")
    .select("inventory_item_id, location_id, posted_base_quantity, receipt_line_id, movement_id, base_unit_id")
    .in("posting_id", postingIds);

  const lineRows = (lines ?? []) as {
    inventory_item_id: string;
    location_id: string;
    posted_base_quantity: number;
    receipt_line_id: string;
    movement_id: string;
    base_unit_id: string;
  }[];
  if (lineRows.length === 0) return empty;

  // Map each posted receipt_line back to its delivery lineage (receipt) so we
  // can count how many duplicate lineages fed each (item, location).
  const receiptLineIds = Array.from(new Set(lineRows.map((l) => l.receipt_line_id)));
  const { data: rlRows } = await supabase
    .from("receipt_lines")
    .select("id, receipt_id")
    .in("id", receiptLineIds);
  const receiptByLine = new Map<string, string>();
  for (const rl of (rlRows ?? []) as { id: string; receipt_id: string }[]) receiptByLine.set(rl.id, rl.receipt_id);

  // Aggregate per (item, location).
  type Agg = { posted: number; receipts: Set<string>; baseUnitId: string; movementIds: Set<string> };
  const byKey = new Map<string, Agg>();
  const allMovementIds = new Set<string>();
  for (const l of lineRows) {
    const key = `${l.inventory_item_id}::${l.location_id}`;
    const agg = byKey.get(key) ?? { posted: 0, receipts: new Set<string>(), baseUnitId: l.base_unit_id, movementIds: new Set<string>() };
    agg.posted += Number(l.posted_base_quantity);
    const rid = receiptByLine.get(l.receipt_line_id);
    if (rid) agg.receipts.add(rid);
    agg.movementIds.add(l.movement_id);
    allMovementIds.add(l.movement_id);
    byKey.set(key, agg);
  }

  const itemIds = Array.from(new Set(lineRows.map((l) => l.inventory_item_id)));
  const locationIds = Array.from(new Set(lineRows.map((l) => l.location_id)));
  const [{ data: itemRows }, { data: locRows }] = await Promise.all([
    supabase.from("inventory_items").select("id, name, units:base_unit_id(code)").in("id", itemIds).eq("organization_id", organizationId),
    supabase.from("locations").select("id, name").in("id", locationIds).eq("organization_id", organizationId),
  ]);
  const itemById = new Map<string, { name: string; baseUnitCode: string }>();
  for (const it of (itemRows ?? []) as { id: string; name: string; units: { code?: string } | { code?: string }[] | null }[]) {
    const u = Array.isArray(it.units) ? it.units[0] : it.units;
    itemById.set(it.id, { name: it.name, baseUnitCode: (u as { code?: string } | null)?.code ?? "unit" });
  }
  const locById = new Map<string, string>();
  for (const l of (locRows ?? []) as { id: string; name: string }[]) locById.set(l.id, l.name);

  const items: PostedDeliveryConflictItem[] = [];
  for (const [key, agg] of byKey) {
    const [inventoryItemId, locationId] = key.split("::");
    const lineageCount = Math.max(agg.receipts.size, 1);
    // No duplication for this (item, location): a single lineage fed it. Nothing
    // to correct here even though the document overall is ambiguous.
    if (lineageCount < 2) continue;
    const posted = round6(agg.posted);
    const intended = round6(posted / lineageCount);
    const excess = round6(posted - intended);
    if (excess <= 0) continue;

    const { data: balance } = await supabase.rpc("inventory_location_item_balance", {
      p_organization_id: organizationId,
      p_inventory_item_id: inventoryItemId,
      p_location_id: locationId,
    });
    const currentOnHand = round6(Number(balance ?? 0));
    const proposedDelta = round6(-excess);
    const proposedOnHand = round6(currentOnHand + proposedDelta);
    const meta = itemById.get(inventoryItemId);
    items.push({
      inventoryItemId,
      itemName: meta?.name ?? "Item",
      locationId,
      locationName: locById.get(locationId) ?? "Location",
      baseUnitCode: meta?.baseUnitCode ?? "unit",
      lineageCount,
      postedBaseQuantity: posted,
      intendedBaseQuantity: intended,
      excessBaseQuantity: excess,
      currentOnHand,
      proposedDelta,
      proposedOnHand,
      wouldGoNegative: proposedOnHand < 0,
    });
  }

  items.sort((a, b) => a.itemName.localeCompare(b.itemName) || a.locationName.localeCompare(b.locationName));

  return {
    purchaseDocumentId,
    isPostedConflict: items.length > 0,
    postingIds,
    postedAt: postingRows.map((p) => p.created_at).filter((x): x is string => !!x).sort()[0] ?? null,
    movementIds: Array.from(allMovementIds),
    items,
  };
}
