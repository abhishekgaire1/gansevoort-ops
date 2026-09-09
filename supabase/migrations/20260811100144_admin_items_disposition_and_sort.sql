-- Safe editing of confirmed items with inventory-impact protection (Part 9).
--
-- Widens list_admin_items for the redesigned, full-width Items list
-- (spec section 2): an Inventory-vs-Expense filter (p_disposition,
-- default 'INVENTORY' -- every existing caller passes nothing for this
-- new trailing parameter, so behavior is unchanged unless the UI
-- explicitly asks for 'NON_INVENTORY' or 'ALL'), a sort control
-- (p_sort), and out_updated_at so "sort by last updated" has something
-- to sort on. Body-only replace; no other schema/business-rule change.
create or replace function public.list_admin_items(
  p_organization_id uuid,
  p_search text default null,
  p_category_id uuid default null,
  p_base_unit_code text default null,
  p_status text default null,
  p_disposition text default 'INVENTORY',
  p_sort text default 'name'
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_name text,
  out_base_unit_code text,
  out_status text,
  out_disposition text,
  out_updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ic.name, u.code, ii.status, ii.disposition, ii.updated_at
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
   where ii.organization_id = p_organization_id
     and ii.approval_status = 'CONFIRMED'
     and (p_disposition is null or p_disposition = 'ALL' or ii.disposition = p_disposition)
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

revoke all on function public.list_admin_items(uuid, text, uuid, text, text, text, text) from public;
grant execute on function public.list_admin_items(uuid, text, uuid, text, text, text, text) to service_role;

-- The previous 5-argument signature is superseded (no caller passes
-- fewer than the new full parameter list going forward -- the TS wrapper
-- is updated in the same change) -- drop it so exactly one overload
-- exists.
drop function if exists public.list_admin_items(uuid, text, uuid, text, text);
