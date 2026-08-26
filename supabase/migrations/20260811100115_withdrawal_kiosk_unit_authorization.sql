-- Purchase-versus-usage unit model: close the kiosk-unit-authorization gap.
--
-- Before this migration, enforce_movement_line_measurement() (the trigger
-- backing EVERY inventory_movement_lines insert -- withdrawal, batch
-- withdrawal, waste) only verified that the entered unit was an ACTIVE
-- row in inventory_item_units for the item. It did not, and structurally
-- could not, distinguish a genuine kiosk usage unit from a vendor
-- purchase-only unit -- both are equally "active" rows on the same table.
-- The ONLY thing preventing a withdrawal in a purchase unit today is the
-- kiosk client choosing not to offer one; the server never independently
-- re-derives or re-checks that.
--
-- This migration adds exactly that check, scoped to ISSUE_TO_STATION
-- movements only (withdrawals) -- waste and any future movement type are
-- completely unaffected, matching Section 15's "waste remains
-- base-unit-only in this task" requirement. record_inventory_waste
-- already hardcodes entered_unit_id to the item's base_unit_id directly,
-- and the base unit always has an active primary usage slot (backfilled
-- in 20260811100113), so this change is a no-op for waste even though the
-- trigger technically covers it.
--
-- New app-defined SQLSTATE: GA066 KIOSK_USAGE_UNIT_NOT_AUTHORIZED (highest
-- in use before this migration: GA065, allocated in 20260811100114).
-- GA034 was considered and rejected -- app/lib/admin/errors.ts already
-- claims it for NOT_FOUND.

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
  select organization_id, movement_type into v_movement_org_id, v_movement_type
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

  -- Kiosk-usage authorization (NEW): a withdrawal must use a unit that is
  -- SPECIFICALLY an active kiosk usage slot for this item -- never merely
  -- "active" in inventory_item_units, which a vendor purchase-only unit
  -- also satisfies. This is the database-level guarantee the audit found
  -- missing: the client's own choice of unit is never trusted alone.
  if v_movement_type = 'ISSUE_TO_STATION' then
    if not exists (
      select 1
        from public.inventory_item_usage_units iu
        join public.inventory_item_units iiu on iiu.id = iu.inventory_item_unit_id
       where iu.organization_id = v_movement_org_id
         and iu.inventory_item_id = new.inventory_item_id
         and iiu.unit_id = new.entered_unit_id
         and iu.is_active
         and iiu.is_active
         -- Explicit, independent re-check (Section 12 "unit is
         -- fixed-conversion") -- not merely inferred from the fact that
         -- inventory_item_usage_units' own insert/update trigger already
         -- rejects measured units; a withdrawal must never accept one
         -- even if that other guarantee were ever weakened.
         and not iiu.requires_actual_measurement
    ) then
      raise exception 'entered_unit_id % is not an authorized active kiosk usage unit for inventory_item_id %',
        new.entered_unit_id, new.inventory_item_id
        using errcode = 'GA066';
    end if;
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = new.inventory_item_id;

  new.base_unit_id := v_base_unit_id;

  if v_movement_type = 'PURCHASE_RECEIPT' then
    -- Purchase receiving NEVER trusts inventory_item_units' shared,
    -- per-item conversion_factor for its arithmetic -- that row can only
    -- ever hold ONE vendor's factor at a time (see
    -- upsert_vendor_item_purchase_unit's own comment), so trusting it
    -- here would let a second vendor's (or SKU's) later approval silently
    -- reprice an EARLIER, not-yet-posted document. post_purchase_document_
    -- inventory (20260811100117) resolves the correct vendor-scoped
    -- factor itself -- from vendor_item_purchase_units, or from the
    -- receiving manager's own verified actual measurement -- and always
    -- supplies the final, authoritative base quantity here directly. This
    -- trigger's only remaining job for a purchase receipt is to trust
    -- that already-resolved number, never recompute it.
    if new.measured_base_quantity is null then
      raise exception 'PURCHASE_RECEIPT movement lines must supply an authoritative pre-resolved base quantity';
    end if;
    new.normalized_base_quantity := new.measured_base_quantity;
    return new;
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
