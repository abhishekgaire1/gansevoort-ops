-- Global Inventory Activity milestone -- a second, org-wide READ VIEW over
-- the SAME authoritative ledger (inventory_movements/
-- inventory_movement_lines) list_inventory_item_activity (20260811100089)
-- already reads. No new "history" table, no duplicated ledger data, no
-- new movement types, no write path in this migration.
--
-- ============================================================
-- list_inventory_activity -- every item, every location, one org, newest
-- first, keyset-paginated, with the optional filters the global feed
-- needs (item/vendor/document search, movement type, location, employee,
-- station, date range) that list_inventory_item_activity deliberately
-- doesn't need (it's already scoped to one item+location).
-- ============================================================
-- Join shape is otherwise identical to list_inventory_item_activity --
-- see that migration's own comment for why each LEFT JOIN is safe/sparse
-- by construction. p_search matches item name, vendor name, or document
-- number (ILIKE substring) -- deliberately not full-text search
-- infrastructure, per this milestone's own explicit scope.
create function public.list_inventory_activity(
  p_organization_id uuid,
  p_search text default null,
  p_movement_types text[] default null,
  p_location_id uuid default null,
  p_employee_app_user_id uuid default null,
  p_station_id uuid default null,
  p_from_date timestamptz default null,
  p_to_date timestamptz default null,
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
  out_inventory_item_id uuid,
  out_item_name text,
  out_location_id uuid,
  out_location_name text,
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
    ii.id,
    ii.name,
    m.location_id,
    loc.name,
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
  join public.inventory_items ii on ii.id = ml.inventory_item_id
  join public.units u on u.id = ml.base_unit_id
  join public.locations loc on loc.id = m.location_id
  left join public.stations st on st.id = m.station_id
  left join public.purchase_document_inventory_posting_lines pil on pil.movement_line_id = ml.id
  left join public.purchase_document_inventory_postings pdp on pdp.id = pil.posting_id
  left join public.purchase_documents pd on pd.id = pdp.purchase_document_id
  left join public.vendors v on v.id = pd.vendor_id
  left join public.inventory_waste_events we on we.inventory_movement_id = m.id
  left join public.inventory_cycle_count_lines ccl on ccl.id = ml.cycle_count_line_id
  where m.organization_id = p_organization_id
    and ii.organization_id = p_organization_id
    and (
      p_search is null or btrim(p_search) = ''
      or ii.name ilike '%' || p_search || '%'
      or v.name ilike '%' || p_search || '%'
      or pd.document_number ilike '%' || p_search || '%'
    )
    and (p_movement_types is null or m.movement_type = any (p_movement_types))
    and (p_location_id is null or m.location_id = p_location_id)
    and (p_employee_app_user_id is null or m.performed_by_app_user_id = p_employee_app_user_id)
    and (p_station_id is null or m.station_id = p_station_id)
    and (p_from_date is null or m.occurred_at >= p_from_date)
    and (p_to_date is null or m.occurred_at <= p_to_date)
    and (
      p_before_occurred_at is null
      or (m.occurred_at, ml.id) < (p_before_occurred_at, p_before_id)
    )
  order by m.occurred_at desc, ml.id desc
  limit p_limit;
$$;

revoke all on function public.list_inventory_activity(uuid, text, text[], uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, integer) from public;
grant execute on function public.list_inventory_activity(uuid, text, text[], uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, integer) to service_role;

-- ============================================================
-- New index -- genuinely needed here, unlike list_inventory_item_activity
-- (which stayed index-free): that RPC is always scoped to one item+
-- location first (a narrow, already-indexed predicate), but this feed's
-- single most common case is NO item/location filter at all -- "show me
-- everything, newest first" -- which needs efficient (organization_id,
-- occurred_at DESC) access for both the base scan and keyset pagination.
-- No existing index leads with occurred_at at all.
-- ============================================================
create index inventory_movements_org_occurred_at_idx
  on public.inventory_movements (organization_id, occurred_at desc, id desc);
