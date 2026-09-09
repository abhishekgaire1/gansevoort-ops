-- Safe editing of confirmed items with inventory-impact protection
-- (Part 12) -- revert, found by this feature's own test suite before
-- shipping.
--
-- 20260811100144/100145 widened list_admin_items/get_admin_item to also
-- surface NON_INVENTORY (expense) rows, on the assumption that the
-- spec's "Inventory/expense filter" meant the Admin Item Master surface
-- itself should show both. tests/adminItemMaster.rpc.test.ts already had
-- a dedicated, deliberately-named describe block proving the OPPOSITE is
-- an intentional, tested product rule: "Non-inventory / pending-review
-- items never appear in the Admin Item Master surfaces" -- NON_INVENTORY
-- rows are vendor-mapping/expense-classification targets, a different
-- domain concept from the inventory catalog this workspace manages
-- (they have no balance, no vendor purchase package, no base unit, no
-- kiosk usage units -- nothing in the redesigned workspace applies to
-- them). Widening past that was a silent, unintended business-rule
-- change (CLAUDE.md: "Do not modify business rules silently") --
-- reverted here, in the SAME session that introduced it, before this
-- ever shipped.
--
-- Keeps every OTHER, unrelated widening from those two migrations
-- (p_sort/out_updated_at on list_admin_items; spend category/default
-- receiving location on get_admin_item) -- only the disposition filter
-- itself reverts to the original, hard 'INVENTORY'-only behavior.
drop function if exists public.list_admin_items(uuid, text, uuid, text, text, text, text);

create function public.list_admin_items(
  p_organization_id uuid,
  p_search text default null,
  p_category_id uuid default null,
  p_base_unit_code text default null,
  p_status text default null,
  p_sort text default 'name'
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_name text,
  out_base_unit_code text,
  out_status text,
  out_updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ic.name, u.code, ii.status, ii.updated_at
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
   where ii.organization_id = p_organization_id
     and ii.disposition = 'INVENTORY'
     and ii.approval_status = 'CONFIRMED'
     and (p_search is null or btrim(p_search) = '' or ii.name ilike '%' || p_search || '%' or ii.item_number ilike '%' || p_search || '%')
     and (p_category_id is null or ii.category_id = p_category_id)
     and (p_base_unit_code is null or u.code = p_base_unit_code)
     and (p_status is null or ii.status = p_status)
   order by
     case when p_sort = 'item_number' then ii.item_number end,
     case when p_sort = 'category' then ic.name end,
     case when p_sort = 'updated' then ii.updated_at end desc,
     ii.name;
$$;

revoke all on function public.list_admin_items(uuid, text, uuid, text, text, text) from public;
grant execute on function public.list_admin_items(uuid, text, uuid, text, text, text) to service_role;

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
         ii.spend_category_id, sc.name,
         ii.default_receiving_location_id, loc.name
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
    left join public.spend_categories sc on sc.id = ii.spend_category_id
    left join public.locations loc on loc.id = ii.default_receiving_location_id
   where ii.organization_id = p_organization_id
     and ii.id = p_item_id
     and ii.disposition = 'INVENTORY'
     and ii.approval_status = 'CONFIRMED';
$$;

revoke all on function public.get_admin_item(uuid, uuid) from public;
grant execute on function public.get_admin_item(uuid, uuid) to service_role;
