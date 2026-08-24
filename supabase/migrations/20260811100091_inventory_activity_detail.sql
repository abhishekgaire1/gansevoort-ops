-- Global Inventory Activity milestone -- a precise, single-row detail
-- lookup for the activity detail route (/manager/inventory/activity/
-- [movementLineId]), by the movement_line's own id. Deliberately NOT
-- implemented by paginating list_inventory_activity until a match is
-- found (that would be both slow and, past whatever page-walk bound was
-- chosen, silently incorrect for an org with enough history) -- same
-- join shape as list_inventory_activity (20260811100090), filtered
-- directly to one line.
create function public.get_inventory_activity_detail(
  p_organization_id uuid,
  p_movement_line_id uuid
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
    and ml.id = p_movement_line_id;
$$;

revoke all on function public.get_inventory_activity_detail(uuid, uuid) from public;
grant execute on function public.get_inventory_activity_detail(uuid, uuid) to service_role;
