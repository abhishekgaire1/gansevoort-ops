-- Milestone 2A.5 -- kiosk browser-testing fix: the item-selection grid
-- was listing every active/confirmed INVENTORY Item Master row
-- (listActiveInventoryItemsForOrganization), regardless of whether the
-- item had any actual stocked balance anywhere -- an item with zero
-- inventory (e.g. never received, or fully depleted) still appeared as a
-- selectable card, only to dead-end on "No inventory is currently
-- available" once tapped.
--
-- Product rule: the kiosk is a WITHDRAWAL interface. Its normal grid
-- must show ONLY items with a POSITIVE total available balance in at
-- least one active, storage-eligible location -- never the full Item
-- Master catalog. Item Master membership and physical availability are
-- different concepts; this was conflating them.
--
-- One efficient server-side query (never one balance request per card):
-- cross-joins the small set of confirmed INVENTORY items against the
-- small set of storage-eligible locations for the org, calls the
-- existing inventory_location_item_balance(org, item, location)
-- (20260811100073 -- the SAME authoritative exact+frozen-legacy formula
-- the manager page and per-item kiosk lookup already use, never a second
-- interpretation), keeps only positive-balance pairs, and aggregates per
-- item: total available quantity, how many locations are positive, and
-- -- when exactly one location is positive -- that location's own
-- identity and full-stock reference, so the grid card can show a real
-- gauge immediately without a second round trip. No prices, no invoice
-- data, no non-inventory items, no inactive/unconfirmed items.

create function public.list_kiosk_available_inventory(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_item_name text,
  out_category_id uuid,
  out_category_name text,
  out_base_unit_code text,
  out_total_available_quantity numeric,
  out_positive_location_count integer,
  out_single_location_id uuid,
  out_single_location_name text,
  out_single_location_full_reference_quantity numeric,
  out_single_location_reference_source text
)
language sql
stable
security definer
set search_path = ''
as $$
  with candidate_locations as (
    select ii.id as inventory_item_id, loc.id as location_id
      from public.inventory_items ii
      cross join public.locations loc
     where ii.organization_id = p_organization_id
       and ii.status = 'active'
       and ii.approval_status = 'CONFIRMED'
       and ii.disposition = 'INVENTORY'
       and loc.organization_id = p_organization_id
       and loc.is_active
       and loc.is_storage_eligible
  ),
  positive_only as (
    select inventory_item_id, location_id, public.inventory_location_item_balance(p_organization_id, inventory_item_id, location_id) as balance
      from candidate_locations
  ),
  positive_filtered as (
    select * from positive_only where balance > 0
  ),
  agg as (
    select inventory_item_id, sum(balance) as total_qty, count(*) as loc_count
      from positive_filtered
     group by inventory_item_id
  ),
  single_location as (
    select pf.inventory_item_id, pf.location_id
      from positive_filtered pf
      join agg on agg.inventory_item_id = pf.inventory_item_id and agg.loc_count = 1
  )
  select
    agg.inventory_item_id,
    ii.name,
    ii.category_id,
    cat.name,
    u.code,
    agg.total_qty,
    agg.loc_count::integer,
    sl.location_id,
    loc.name,
    ref.full_quantity,
    ref.source
  from agg
  join public.inventory_items ii on ii.id = agg.inventory_item_id
  join public.inventory_categories cat on cat.id = ii.category_id
  join public.units u on u.id = ii.base_unit_id
  left join single_location sl on sl.inventory_item_id = agg.inventory_item_id
  left join public.locations loc on loc.id = sl.location_id
  left join lateral (
    select r.full_quantity, r.source
      from public.inventory_stock_references r
     where r.organization_id = p_organization_id
       and r.inventory_item_id = agg.inventory_item_id
       and r.location_id = sl.location_id
     order by r.created_at desc, r.id desc
     limit 1
  ) ref on sl.location_id is not null
  order by ii.name;
$$;

revoke all on function public.list_kiosk_available_inventory(uuid) from public;
grant execute on function public.list_kiosk_available_inventory(uuid) to service_role;
