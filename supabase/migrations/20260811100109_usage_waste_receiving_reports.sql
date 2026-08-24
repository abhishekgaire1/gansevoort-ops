-- V1 Reports foundation -- Inventory Usage, Inventory Waste, and
-- Receiving reports (Section 32/34/35). Three read-only, single-round-
-- trip jsonb RPCs, no new tables. Each mirrors the exact same
-- trustworthiness rules already established elsewhere in this schema:
-- movements/waste events are the append-only ledger truth (never a
-- second derived total), and quantities are only ever summed WITHIN one
-- item + one base unit (Section 32's explicit "do not sum incompatible
-- physical units into nonsense totals" -- the same discipline
-- get_inventory_item_price_history already applies to money).
create function public.get_inventory_usage_report(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_station_id uuid default null,
  p_inventory_item_id uuid default null,
  p_location_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select
      ml.inventory_item_id,
      ii.name as item_name,
      ml.normalized_base_quantity,
      u.code as base_unit_code,
      m.station_id,
      s.name as station_name
    from public.inventory_movement_lines ml
    join public.inventory_movements m on m.id = ml.movement_id and m.organization_id = p_organization_id
    join public.inventory_items ii on ii.id = ml.inventory_item_id and ii.organization_id = p_organization_id
    join public.units u on u.id = ml.base_unit_id
    left join public.stations s on s.id = m.station_id
    where ml.organization_id = p_organization_id
      and m.movement_type = 'ISSUE_TO_STATION'
      and m.business_date between p_date_from and p_date_to
      and (p_station_id is null or m.station_id = p_station_id)
      and (p_inventory_item_id is null or ml.inventory_item_id = p_inventory_item_id)
      and (p_location_id is null or m.location_id = p_location_id)
  )
  select jsonb_build_object(
    'movementCount', (select count(*) from lines),
    'byItem', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('itemId', inventory_item_id, 'itemName', item_name, 'baseUnitCode', base_unit_code, 'quantity', sum(normalized_base_quantity)) as row
        from lines group by inventory_item_id, item_name, base_unit_code order by sum(normalized_base_quantity) desc limit 20
      ) t
    ), '[]'::jsonb),
    'byStation', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('stationId', station_id, 'stationName', coalesce(station_name, 'Unknown'), 'movementCount', count(*)) as row
        from lines group by station_id, station_name order by count(*) desc limit 20
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_inventory_usage_report(uuid, date, date, uuid, uuid, uuid) from public;
grant execute on function public.get_inventory_usage_report(uuid, date, date, uuid, uuid, uuid) to service_role;

-- Waste is joined back to its OWN originating movement's business_date
-- (never inventory_waste_events.recorded_at::date, a plain UTC-instant
-- truncation) for the same org-timezone-aware date filtering every other
-- report in this schema already uses.
create function public.get_inventory_waste_report(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_inventory_item_id uuid default null,
  p_location_id uuid default null,
  p_reason_code text default null,
  p_inventory_category_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with events as (
    select
      w.inventory_item_id,
      ii.name as item_name,
      ii.category_id,
      w.quantity,
      w.unit_code,
      w.reason_code
    from public.inventory_waste_events w
    join public.inventory_movements m on m.id = w.inventory_movement_id and m.organization_id = p_organization_id
    join public.inventory_items ii on ii.id = w.inventory_item_id and ii.organization_id = p_organization_id
    where w.organization_id = p_organization_id
      and m.business_date between p_date_from and p_date_to
      and (p_inventory_item_id is null or w.inventory_item_id = p_inventory_item_id)
      and (p_location_id is null or w.location_id = p_location_id)
      and (p_reason_code is null or w.reason_code = p_reason_code)
      and (p_inventory_category_id is null or ii.category_id = p_inventory_category_id)
  )
  select jsonb_build_object(
    'eventCount', (select count(*) from events),
    'byItem', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('itemId', inventory_item_id, 'itemName', item_name, 'unitCode', unit_code, 'quantity', sum(quantity)) as row
        from events group by inventory_item_id, item_name, unit_code order by sum(quantity) desc limit 20
      ) t
    ), '[]'::jsonb),
    'byReason', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('reasonCode', reason_code, 'eventCount', count(*)) as row
        from events group by reason_code order by count(*) desc
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_inventory_waste_report(uuid, date, date, uuid, uuid, text, uuid) from public;
grant execute on function public.get_inventory_waste_report(uuid, date, date, uuid, uuid, text, uuid) to service_role;

-- Receiving report: document counts by status/vendor, credit-line
-- visibility, and the SAME posting-status derivation as
-- get_purchase_documents_inventory_posting_status (20260811100107) for
-- VERIFIED documents in range, collapsed to three summary counts rather
-- than per-document rows (a report needs totals, not a second queue).
create function public.get_receiving_report(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_vendor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with docs as (
    select pd.id, pd.status, pd.vendor_id, v.name as vendor_name
    from public.purchase_documents pd
    join public.vendors v on v.id = pd.vendor_id and v.organization_id = p_organization_id
    where pd.organization_id = p_organization_id
      and pd.document_date between p_date_from and p_date_to
      and (p_vendor_id is null or pd.vendor_id = p_vendor_id)
  ),
  posting as (
    select
      d.id,
      case
        when d.status <> 'VERIFIED' then null
        when agg.required_count is null or agg.posted_count = 0 then 'NOT_POSTED'
        when agg.posted_count < agg.required_count then 'PARTIALLY_POSTED'
        else 'POSTED'
      end as posting_status
    from docs d
    left join lateral (
      select
        count(*) as required_count,
        count(*) filter (where pl.id is not null) as posted_count
      from public.effective_receipts_for_purchase_document(d.id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = d.id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
      where rl.matched_line_key is not null
        and rl.actual_received_package_quantity is not null
        and rl.actual_received_package_quantity > 0
    ) agg on d.status = 'VERIFIED'
  )
  select jsonb_build_object(
    'documentCount', (select count(*) from docs),
    'byStatus', coalesce((
      select jsonb_agg(row) from (select jsonb_build_object('status', status, 'count', count(*)) as row from docs group by status) t
    ), '[]'::jsonb),
    'byVendor', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object('vendorId', vendor_id, 'vendorName', vendor_name, 'count', count(*)) as row
        from docs group by vendor_id, vendor_name order by count(*) desc limit 15
      ) t
    ), '[]'::jsonb),
    'creditLineCount', (
      select count(*) from public.purchase_document_lines pdl
      join docs d on d.id = pdl.purchase_document_id
      where pdl.organization_id = p_organization_id and pdl.line_total < 0
    ),
    'readyToPostCount', (select count(*) from posting where posting_status = 'NOT_POSTED'),
    'partiallyPostedCount', (select count(*) from posting where posting_status = 'PARTIALLY_POSTED'),
    'postedCount', (select count(*) from posting where posting_status = 'POSTED')
  );
$$;

revoke all on function public.get_receiving_report(uuid, date, date, uuid) from public;
grant execute on function public.get_receiving_report(uuid, date, date, uuid) to service_role;
