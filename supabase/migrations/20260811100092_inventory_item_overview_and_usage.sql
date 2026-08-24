-- Inventory Item Detail Overview + Usage milestone -- three focused,
-- read-only RPCs. No new tables, no new movement types, no change to any
-- write path. All three enforce org isolation via p_organization_id
-- filters on every joined table, exactly like every other RPC in this
-- schema.
--
-- ============================================================
-- 1. get_inventory_item_last_received -- Overview's "Last Received"
--    section, including a narrowly-scoped Unit Cost.
-- ============================================================
-- Unit cost is deliberately computed as
--   purchase_document_lines.line_total / posting_line.posted_base_quantity
-- -- NOT unit_price times some client-side unit conversion. Both operands
-- are already authoritative, already-normalized numbers this schema
-- computes itself (line_total is the invoice line's own total dollar
-- amount; posted_base_quantity is the exact base-unit quantity that
-- posting actually wrote to the ledger, regardless of whether the item
-- used SAME_UNIT/FIXED_CONVERSION/MEASURE_EACH_DELIVERY receiving). This
-- sidesteps ever multiplying a price by an unproven/incompatible unit
-- (Part 8's explicit "do not multiply LB x CASE PRICE" warning) -- there
-- is no conversion step here to get wrong. line_total is nullable (OCR
-- extraction may not always capture it); when null, out_unit_cost is
-- null and the caller must omit the field, never show $0.
create function public.get_inventory_item_last_received(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid
)
returns table (
  out_movement_line_id uuid,
  out_occurred_at timestamptz,
  out_quantity numeric,
  out_base_unit_code text,
  out_performed_by_app_user_id uuid,
  out_purchase_document_id uuid,
  out_document_number text,
  out_vendor_id uuid,
  out_vendor_name text,
  out_unit_cost numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ml.id,
    m.occurred_at,
    ml.normalized_base_quantity,
    u.code,
    m.performed_by_app_user_id,
    pd.id,
    pd.document_number,
    pd.vendor_id,
    v.name,
    case
      when pdl.line_total is not null and pil.posted_base_quantity > 0
        then pdl.line_total / pil.posted_base_quantity
      else null
    end
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  join public.units u on u.id = ml.base_unit_id
  left join public.purchase_document_inventory_posting_lines pil on pil.movement_line_id = ml.id
  left join public.purchase_document_inventory_postings pdp on pdp.id = pil.posting_id
  left join public.purchase_documents pd on pd.id = pdp.purchase_document_id
  left join public.vendors v on v.id = pd.vendor_id
  left join public.receipt_lines rl on rl.id = pil.receipt_line_id
  left join public.purchase_document_lines pdl
    on pdl.purchase_document_id = pd.id
   and pdl.organization_id = p_organization_id
   and pdl.line_key = rl.matched_line_key
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and m.movement_type = 'PURCHASE_RECEIPT'
  order by m.occurred_at desc, ml.id desc
  limit 1;
$$;

revoke all on function public.get_inventory_item_last_received(uuid, uuid, uuid) from public;
grant execute on function public.get_inventory_item_last_received(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 2. get_inventory_item_usage_totals -- Overview's compact "Recent
--    Withdrawals" (Today / 7 Days / 30 Days), one query, one scan.
-- ============================================================
-- "Usage" here means ONLY ISSUE_TO_STATION movement lines for this exact
-- item + location -- never receiving, Waste, or Cycle Count adjustments
-- (Part 1/10). Period boundaries are computed from the LOCATION's own
-- timezone (business_date convention already used by every write RPC in
-- this schema), never a client-supplied timestamp -- "Today" is the
-- location's current business day, "7 Days"/"30 Days" are that many
-- calendar days ending today, inclusive.
create function public.get_inventory_item_usage_totals(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid
)
returns table (
  out_base_unit_code text,
  out_today_quantity numeric,
  out_seven_day_quantity numeric,
  out_thirty_day_quantity numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with loc as (
    select timezone from public.locations where id = p_location_id and organization_id = p_organization_id
  ),
  bounds as (
    select
      (now() at time zone (select timezone from loc))::date as today,
      ((now() at time zone (select timezone from loc))::date - interval '6 days') as seven_start,
      ((now() at time zone (select timezone from loc))::date - interval '29 days') as thirty_start,
      (select timezone from loc) as tz
  ),
  item_unit as (
    select u.code from public.inventory_items ii join public.units u on u.id = ii.base_unit_id
     where ii.id = p_inventory_item_id and ii.organization_id = p_organization_id
  )
  select
    (select code from item_unit),
    coalesce(sum(ml.normalized_base_quantity) filter (
      where (m.occurred_at at time zone (select tz from bounds))::date = (select today from bounds)
    ), 0),
    coalesce(sum(ml.normalized_base_quantity) filter (
      where (m.occurred_at at time zone (select tz from bounds))::date >= (select seven_start from bounds)
    ), 0),
    coalesce(sum(ml.normalized_base_quantity) filter (
      where (m.occurred_at at time zone (select tz from bounds))::date >= (select thirty_start from bounds)
    ), 0)
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and m.movement_type = 'ISSUE_TO_STATION'
    and (m.occurred_at at time zone (select tz from bounds))::date >= (select thirty_start from bounds);
$$;

revoke all on function public.get_inventory_item_usage_totals(uuid, uuid, uuid) from public;
grant execute on function public.get_inventory_item_usage_totals(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 3. get_inventory_item_usage_by_station -- the Usage tab's primary
--    feature. p_period is 'TODAY' | 'SEVEN_DAYS' | 'THIRTY_DAYS',
--    bounds computed the same way as get_inventory_item_usage_totals.
-- ============================================================
create function public.get_inventory_item_usage_by_station(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_period text
)
returns table (
  out_station_id uuid,
  out_station_name text,
  out_quantity numeric,
  out_base_unit_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  with loc as (
    select timezone from public.locations where id = p_location_id and organization_id = p_organization_id
  ),
  bounds as (
    select
      case p_period
        when 'TODAY' then (now() at time zone (select timezone from loc))::date
        when 'SEVEN_DAYS' then (now() at time zone (select timezone from loc))::date - interval '6 days'
        else (now() at time zone (select timezone from loc))::date - interval '29 days'
      end as period_start,
      (select timezone from loc) as tz
  ),
  item_unit as (
    select u.code from public.inventory_items ii join public.units u on u.id = ii.base_unit_id
     where ii.id = p_inventory_item_id and ii.organization_id = p_organization_id
  )
  select m.station_id, st.name, sum(ml.normalized_base_quantity), (select code from item_unit)
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  join public.stations st on st.id = m.station_id
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and m.movement_type = 'ISSUE_TO_STATION'
    and (m.occurred_at at time zone (select tz from bounds))::date >= (select period_start from bounds)
  group by m.station_id, st.name
  order by sum(ml.normalized_base_quantity) desc;
$$;

revoke all on function public.get_inventory_item_usage_by_station(uuid, uuid, uuid, text) from public;
grant execute on function public.get_inventory_item_usage_by_station(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 4. get_inventory_item_usage_trend -- daily buckets, SEVEN_DAYS/
--    THIRTY_DAYS only (Today's trend is intentionally not built -- Part
--    19: "hourly buckets are NOT necessary for V1"). Sparse (a day with
--    zero withdrawals produces no row) -- zero-filling for a continuous
--    chart is presentation-layer work, done in TypeScript.
-- ============================================================
create function public.get_inventory_item_usage_trend(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_period text
)
returns table (
  out_bucket_date date,
  out_quantity numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with loc as (
    select timezone from public.locations where id = p_location_id and organization_id = p_organization_id
  ),
  bounds as (
    select
      case p_period
        when 'SEVEN_DAYS' then (now() at time zone (select timezone from loc))::date - interval '6 days'
        else (now() at time zone (select timezone from loc))::date - interval '29 days'
      end as period_start,
      (select timezone from loc) as tz
  )
  select (m.occurred_at at time zone (select tz from bounds))::date, sum(ml.normalized_base_quantity)
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and m.movement_type = 'ISSUE_TO_STATION'
    and (m.occurred_at at time zone (select tz from bounds))::date >= (select period_start from bounds)
  group by 1
  order by 1;
$$;

revoke all on function public.get_inventory_item_usage_trend(uuid, uuid, uuid, text) from public;
grant execute on function public.get_inventory_item_usage_trend(uuid, uuid, uuid, text) to service_role;
