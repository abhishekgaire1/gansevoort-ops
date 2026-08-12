-- Enforce base-unit-only withdrawals at the database layer
--
-- Product decision: an employee withdrawal (ISSUE_TO_STATION) may only ever
-- be entered in the item's own canonical base unit
-- (inventory_items.base_unit_id) -- never a packaging unit like
-- BOX/CASE/PACK. Those packaging units remain valid, ACTIVE
-- inventory_item_units rows (kept for a future receiving/purchasing
-- workflow), so without this migration a modified/stale client could still
-- submit one of them directly to record_inventory_withdrawal(): the
-- pre-existing enforce_movement_line_measurement() trigger only checked
-- that entered_unit_id was *some* allowed active unit for the item, not
-- specifically its base unit.
--
-- This must not be UI-only, so the check is added to the trigger itself
-- (not just record_inventory_withdrawal(), and not just the kiosk) -- it
-- protects at the inventory_movement_lines table level regardless of which
-- function performs the insert, the same defense-in-depth spirit as the
-- rest of this trigger. It is deliberately gated on movement_type =
-- 'ISSUE_TO_STATION' (not applied unconditionally) so a future
-- receiving/purchasing movement type, which the table's own CHECK
-- constraint does not yet allow, can freely use packaging units without
-- requiring another migration to carve out an exception here.
--
-- Per "do not modify previously applied migrations," this replaces the
-- function in place with CREATE OR REPLACE (the same pattern already used
-- by 20260811100014's fix) rather than editing 20260811100005 -- the
-- trigger definition (`before insert ... execute function
-- enforce_movement_line_measurement()`) already created there is left
-- untouched and automatically picks up this new function body.

create or replace function public.enforce_movement_line_measurement()
returns trigger
language plpgsql
as $$
declare
  v_conversion_factor numeric;
  v_requires_measurement boolean;
  v_base_unit_id uuid;
  v_movement_org_id uuid;
  v_movement_type text;
begin
  select organization_id, movement_type
    into v_movement_org_id, v_movement_type
    from public.inventory_movements
   where id = new.movement_id;

  if not found then
    raise exception 'movement_id % does not exist', new.movement_id;
  end if;

  new.organization_id := v_movement_org_id;

  select requires_actual_measurement, conversion_factor
    into v_requires_measurement, v_conversion_factor
    from public.inventory_item_units
   where inventory_item_id = new.inventory_item_id
     and unit_id = new.entered_unit_id
     and is_active;

  if not found then
    raise exception 'entered_unit_id % is not an allowed active unit for inventory_item_id %',
      new.entered_unit_id, new.inventory_item_id;
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = new.inventory_item_id;

  new.base_unit_id := v_base_unit_id;

  -- Withdrawal-unit simplification: a stale/modified client cannot bypass
  -- this by sending a packaging unit's id (e.g. BOX) directly -- even
  -- though that id is itself a legitimately configured, active
  -- inventory_item_units row, kept for future receiving.
  if v_movement_type = 'ISSUE_TO_STATION' and new.entered_unit_id is distinct from v_base_unit_id then
    raise exception 'entered_unit_id % must be inventory_item_id %''s base unit % for an ISSUE_TO_STATION withdrawal',
      new.entered_unit_id, new.inventory_item_id, v_base_unit_id;
  end if;

  if v_requires_measurement then
    if new.measured_base_quantity is null then
      raise exception 'inventory_item_id % requires an actual measured quantity when entered in unit %',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    new.normalized_base_quantity := new.measured_base_quantity;
  else
    if new.measured_base_quantity is not null then
      raise exception 'inventory_item_id % has a fixed conversion for unit % and must not supply measured_base_quantity',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    if v_conversion_factor is null then
      raise exception 'inventory_item_id % has no conversion_factor defined for unit %',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    new.normalized_base_quantity := new.entered_quantity * v_conversion_factor;
  end if;

  return new;
end;
$$;
