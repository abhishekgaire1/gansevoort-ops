-- Inventory Item Detail + Activity History milestone -- one focused,
-- read-only RPC over the EXISTING authoritative ledger
-- (inventory_movements/inventory_movement_lines) and its existing source
-- records (purchase_document_inventory_posting_lines/postings/
-- purchase_documents/vendors, inventory_waste_events,
-- inventory_cycle_count_lines/inventory_cycle_counts, stations, locations).
--
-- No new movement types, no new "history" table, no duplicated ledger
-- data. This is purely a presentation-friendly READ over rows that
-- already exist -- the ledger itself is untouched.
--
-- ============================================================
-- list_inventory_item_activity -- one item's movement history at one
-- exact storage location, newest first, keyset-paginated.
-- ============================================================
-- Query shape mirrors list_inventory_balances_for_item (20260811100075):
-- filters inventory_movement_lines by inventory_item_id, joins
-- inventory_movements filtered by (organization_id, location_id) -- the
-- same predicate inventory_movements_org_location_type_idx already
-- supports -- then LEFT JOINs each movement's real source record only
-- where that relationship genuinely exists for that movement_type
-- (a PURCHASE_RECEIPT row will never match inventory_waste_events, a
-- WASTE row will never match a posting line, etc; every join is
-- naturally sparse by construction, not by a CASE/WHEN branch).
--
-- Employee/manager display names are deliberately NOT resolved here --
-- every other read model in this schema (list_cycle_count_summaries,
-- list_inventory_waste_events, getInventoryPostingDetail) resolves
-- app_user -> employee names in the TypeScript layer via the shared
-- resolveEmployeeDisplayNames() helper, not inside SQL. This RPC returns
-- performed_by_app_user_id raw, for the same reason.
--
-- p_movement_types is an array (not a single value) so the UI's single
-- "Cycle Counts" filter option can mean BOTH COUNT_ADJUSTMENT_IN and
-- COUNT_ADJUSTMENT_OUT without the caller issuing two requests.
--
-- Keyset pagination: (m.occurred_at, ml.id) < (p_before_occurred_at,
-- p_before_id) on the first page's cursor is null, so nothing is
-- excluded. Deterministic ordering (occurred_at desc, id desc) matches
-- what's documented for this milestone.
create function public.list_inventory_item_activity(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_movement_types text[] default null,
  p_before_occurred_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (
  out_movement_line_id uuid,
  out_movement_id uuid,
  out_movement_type text,
  out_occurred_at timestamptz,
  out_quantity numeric,
  out_base_unit_code text,
  out_location_attribution text,
  out_station_id uuid,
  out_station_name text,
  out_performed_by_app_user_id uuid,
  out_purchase_document_id uuid,
  out_document_number text,
  out_vendor_id uuid,
  out_vendor_name text,
  out_waste_event_id uuid,
  out_waste_reason_code text,
  out_waste_note text,
  out_cycle_count_id uuid,
  out_cycle_count_expected_quantity numeric,
  out_cycle_count_physical_quantity numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ml.id,
    m.id,
    m.movement_type,
    m.occurred_at,
    ml.normalized_base_quantity,
    u.code,
    m.location_attribution,
    m.station_id,
    st.name,
    m.performed_by_app_user_id,
    pd.id,
    pd.document_number,
    pd.vendor_id,
    v.name,
    we.id,
    we.reason_code,
    we.note,
    m.cycle_count_id,
    ccl.expected_quantity_at_snapshot,
    ccl.physical_count_quantity
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  join public.units u on u.id = ml.base_unit_id
  left join public.stations st on st.id = m.station_id
  left join public.purchase_document_inventory_posting_lines pil on pil.movement_line_id = ml.id
  left join public.purchase_document_inventory_postings pdp on pdp.id = pil.posting_id
  left join public.purchase_documents pd on pd.id = pdp.purchase_document_id
  left join public.vendors v on v.id = pd.vendor_id
  left join public.inventory_waste_events we on we.inventory_movement_id = m.id
  left join public.inventory_cycle_count_lines ccl on ccl.id = ml.cycle_count_line_id
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and (p_movement_types is null or m.movement_type = any (p_movement_types))
    and (
      p_before_occurred_at is null
      or (m.occurred_at, ml.id) < (p_before_occurred_at, p_before_id)
    )
  order by m.occurred_at desc, ml.id desc
  limit p_limit;
$$;

revoke all on function public.list_inventory_item_activity(uuid, uuid, uuid, text[], timestamptz, uuid, integer) from public;
grant execute on function public.list_inventory_item_activity(uuid, uuid, uuid, text[], timestamptz, uuid, integer) to service_role;

-- No new index: this query's two predicates (organization_id, location_id)
-- on inventory_movements are already served by
-- inventory_movements_org_location_type_idx (20260811100075), and the
-- join back to inventory_movement_lines filtered by inventory_item_id is
-- already served by inventory_movement_lines_movement_item_idx
-- (movement_id, inventory_item_id) (also 20260811100075) -- the exact
-- shape this query needs (candidate movement_ids narrowed by the location
-- filter, then matched against this one item). Result sets are bounded by
-- one item's lifetime activity at one location, not by table size; adding
-- a speculative new index for this milestone is not justified.
