-- Safe editing of confirmed items with inventory-impact protection (Part 10).
--
-- get_admin_item widened for the redesigned item workspace's Overview
-- section (spec section 3): disposition, spend category, and the
-- existing default_receiving_location_id/name (20260811100053) --
-- read-only display of an existing setting, not a new editable field.
-- The disposition = 'INVENTORY' filter is also dropped here: the
-- redesigned Items list now shows NON_INVENTORY (expense) items too
-- (20260811100144's disposition filter), so clicking one through to its
-- detail page must not 404 -- approval_status = 'CONFIRMED' remains the
-- only gate, matching list_admin_items' own widened filter.
drop function if exists public.get_admin_item(uuid, uuid);

create function public.get_admin_item(
  p_organization_id uuid,
  p_item_id uuid
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_id uuid,
  out_category_name text,
  out_base_unit_id uuid,
  out_base_unit_code text,
  out_status text,
  out_created_at timestamptz,
  out_updated_at timestamptz,
  out_has_movement_history boolean,
  out_disposition text,
  out_spend_category_id uuid,
  out_spend_category_name text,
  out_default_receiving_location_id uuid,
  out_default_receiving_location_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ii.category_id, ic.name, ii.base_unit_id, u.code, ii.status,
         ii.created_at, ii.updated_at,
         exists (select 1 from public.inventory_movement_lines ml where ml.inventory_item_id = ii.id),
         ii.disposition, ii.spend_category_id, sc.name,
         ii.default_receiving_location_id, loc.name
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
    left join public.spend_categories sc on sc.id = ii.spend_category_id
    left join public.locations loc on loc.id = ii.default_receiving_location_id
   where ii.organization_id = p_organization_id
     and ii.id = p_item_id
     and ii.approval_status = 'CONFIRMED';
$$;

revoke all on function public.get_admin_item(uuid, uuid) from public;
grant execute on function public.get_admin_item(uuid, uuid) to service_role;
