-- Milestone 2A.5 Phase 2 -- kiosk stock-visibility read model: a
-- per-item balance lookup (never the whole org's) plus the two indexes
-- this new hot query pattern actually needs.
--
-- record_inventory_withdrawal's own availability check (20260811100073)
-- and this kiosk read model both filter inventory_movements/
-- inventory_movement_lines by (organization_id, location_id,
-- movement_type) and (movement_id, inventory_item_id) on every call --
-- neither had a supporting index before now (only primary keys and FK-
-- target unique constraints existed), so both were full scans. Added
-- here because this is the exact new query pattern that makes them
-- worth it, not a speculative addition.

create index inventory_movements_org_location_type_idx
  on public.inventory_movements (organization_id, location_id, movement_type);

create index inventory_movement_lines_movement_item_idx
  on public.inventory_movement_lines (movement_id, inventory_item_id);

-- Same three-term formula as inventory_location_balances
-- (20260811100073), scoped to one item -- the kiosk never needs the
-- whole organization's balance table to render one item's availability
-- across its storage locations.
create function public.list_inventory_balances_for_item(
  p_organization_id uuid, p_inventory_item_id uuid
)
returns table (
  out_location_id uuid,
  out_location_name text,
  out_base_unit_code text,
  out_balance numeric,
  out_full_reference_quantity numeric,
  out_reference_source text,
  out_includes_legacy_estimate boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with inbound as (
    select m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and ml.inventory_item_id = p_inventory_item_id
       and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
     group by m.location_id
  ),
  exact_outbound as (
    select m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and ml.inventory_item_id = p_inventory_item_id
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
       and m.location_attribution = 'EXACT'
     group by m.location_id
  ),
  legacy as (
    select location_id, allocated_outbound_quantity as qty
      from public.inventory_legacy_location_allocations
     where organization_id = p_organization_id
       and inventory_item_id = p_inventory_item_id
  ),
  locations_touched as (
    select location_id from inbound
    union
    select location_id from exact_outbound
    union
    select location_id from legacy
  )
  select
    lt.location_id,
    loc.name,
    u.code,
    coalesce(i.qty, 0) - coalesce(eo.qty, 0) - coalesce(lg.qty, 0),
    ref.full_quantity,
    ref.source,
    coalesce(lg.qty, 0) > 0
  from locations_touched lt
  join public.locations loc on loc.id = lt.location_id
  join public.inventory_items ii on ii.id = p_inventory_item_id
  join public.units u on u.id = ii.base_unit_id
  left join inbound i on i.location_id = lt.location_id
  left join exact_outbound eo on eo.location_id = lt.location_id
  left join legacy lg on lg.location_id = lt.location_id
  left join lateral (
    select r.full_quantity, r.source
      from public.inventory_stock_references r
     where r.organization_id = p_organization_id
       and r.inventory_item_id = p_inventory_item_id
       and r.location_id = lt.location_id
     order by r.created_at desc, r.id desc
     limit 1
  ) ref on true
  -- Only locations with a NONZERO current balance are real withdrawal
  -- candidates -- a location that once had stock but is now fully
  -- depleted (balance <= 0) is never offered as a "take from" choice.
  where coalesce(i.qty, 0) - coalesce(eo.qty, 0) - coalesce(lg.qty, 0) > 0
  order by loc.name;
$$;

revoke all on function public.list_inventory_balances_for_item(uuid, uuid) from public;
grant execute on function public.list_inventory_balances_for_item(uuid, uuid) to service_role;
