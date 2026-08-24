-- Inventory Item Detail Overview + Usage milestone -- adds a CUSTOM
-- period to the two Usage-tab RPCs (Part 14's "Custom may be included if
-- there is already a clean reusable date-range control" -- the Global
-- Inventory Activity page's Date From/To inputs already are one, so this
-- reuses that exact UX pattern rather than inventing a new date picker).
--
-- CREATE OR REPLACE cannot add parameters to an existing function's
-- signature, so both are dropped and recreated here (same drop-first
-- requirement documented in several earlier migrations in this schema)
-- -- never edited in place.
--
-- Both functions now always compute an explicit period_end (previously
-- implicit "up to now," since nothing can be later than the current
-- moment) so CUSTOM's end date is handled the exact same way as every
-- other period, not a special case.
drop function if exists public.get_inventory_item_usage_by_station(uuid, uuid, uuid, text);

create function public.get_inventory_item_usage_by_station(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_period text,
  p_custom_start date default null,
  p_custom_end date default null
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
        when 'CUSTOM' then p_custom_start
        else (now() at time zone (select timezone from loc))::date - interval '29 days'
      end as period_start,
      case p_period
        when 'CUSTOM' then p_custom_end
        else (now() at time zone (select timezone from loc))::date
      end as period_end,
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
    and (select period_start from bounds) is not null
    and (select period_end from bounds) is not null
    and (m.occurred_at at time zone (select tz from bounds))::date >= (select period_start from bounds)
    and (m.occurred_at at time zone (select tz from bounds))::date <= (select period_end from bounds)
  group by m.station_id, st.name
  order by sum(ml.normalized_base_quantity) desc;
$$;

revoke all on function public.get_inventory_item_usage_by_station(uuid, uuid, uuid, text, date, date) from public;
grant execute on function public.get_inventory_item_usage_by_station(uuid, uuid, uuid, text, date, date) to service_role;

drop function if exists public.get_inventory_item_usage_trend(uuid, uuid, uuid, text);

create function public.get_inventory_item_usage_trend(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_period text,
  p_custom_start date default null,
  p_custom_end date default null
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
        when 'CUSTOM' then p_custom_start
        else (now() at time zone (select timezone from loc))::date - interval '29 days'
      end as period_start,
      case p_period
        when 'CUSTOM' then p_custom_end
        else (now() at time zone (select timezone from loc))::date
      end as period_end,
      (select timezone from loc) as tz
  )
  select (m.occurred_at at time zone (select tz from bounds))::date, sum(ml.normalized_base_quantity)
  from public.inventory_movement_lines ml
  join public.inventory_movements m on m.id = ml.movement_id
  where m.organization_id = p_organization_id
    and ml.inventory_item_id = p_inventory_item_id
    and m.location_id = p_location_id
    and m.movement_type = 'ISSUE_TO_STATION'
    and (select period_start from bounds) is not null
    and (select period_end from bounds) is not null
    and (m.occurred_at at time zone (select tz from bounds))::date >= (select period_start from bounds)
    and (m.occurred_at at time zone (select tz from bounds))::date <= (select period_end from bounds)
  group by 1
  order by 1;
$$;

revoke all on function public.get_inventory_item_usage_trend(uuid, uuid, uuid, text, date, date) from public;
grant execute on function public.get_inventory_item_usage_trend(uuid, uuid, uuid, text, date, date) to service_role;
