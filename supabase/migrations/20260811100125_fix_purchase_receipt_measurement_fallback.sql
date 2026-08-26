-- Fixes a real regression in 20260811100121's enforce_movement_line_
-- measurement trigger, found by running the full DB-backed test:integration
-- suite against the applied unit-model migrations (this migration is
-- therefore additive/forward-only; 100121 itself is NOT edited, since it
-- was already successfully applied before this regression was found).
--
-- THE REGRESSION: 100121 changed the trigger's PURCHASE_RECEIPT branch to
-- unconditionally REQUIRE an already-supplied measured_base_quantity,
-- reasoning that post_purchase_document_inventory (100123) is the only
-- caller and always supplies one. That assumption was false: at least nine
-- pre-existing test files (sourceAwareWithdrawal.rpc.test.ts,
-- withdrawalBatchRpc.rpc.test.ts, withdrawal.rpc.test.ts,
-- highWithdrawalNotification.rpc.test.ts, cycleCounts.rpc.test.ts,
-- cycleCountHistory.rpc.test.ts, cycleCountWaste.rpc.test.ts,
-- inventoryWaste.rpc.test.ts, devReset.rpc.test.ts) construct a
-- PURCHASE_RECEIPT movement line directly -- a documented, sanctioned
-- "lower-level ledger write" pattern, not a test-only hack -- and relied
-- on this trigger computing the base quantity itself from the shared
-- inventory_item_units row, exactly as it always did for every other
-- movement type. Requiring an explicit value unconditionally broke every
-- one of them (confirmed directly: 124 tests across 21 files failed with
-- "PURCHASE_RECEIPT movement lines must supply an authoritative
-- pre-resolved base quantity").
--
-- THE FIX: restore the fallback. When measured_base_quantity IS supplied
-- (which post_purchase_document_inventory always does, having already
-- resolved the correct vendor-specific factor), trust it exactly as
-- 100121 intended -- vendor-package-aware posting is fully preserved.
-- When it is NOT supplied, compute normalized_base_quantity from
-- entered_quantity * the shared row's conversion_factor, exactly as this
-- trigger did before 100121, so every lower-level/legacy caller keeps
-- working. Body-only replacement of enforce_movement_line_measurement --
-- this is a byte-for-byte copy of the 20260811100121 function body with
-- only that one branch changed -- safe as a bare CREATE OR REPLACE (no
-- signature change, and this is a trigger function, not directly granted
-- to any role).

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
    -- inventory (20260811100123) resolves the correct vendor-scoped
    -- factor itself -- from vendor_item_purchase_units, or from the
    -- receiving manager's own verified actual measurement -- and always
    -- supplies the final, authoritative base quantity here directly. This
    -- trigger's only remaining job for a purchase receipt is to trust
    -- that already-resolved number, never recompute it.
    if new.measured_base_quantity is not null then
      -- vendor-package-aware posting (20260811100123) has already
      -- resolved the authoritative, vendor-specific factor itself and
      -- supplies it directly -- trust it, never recompute from the
      -- shared inventory_item_units row.
      new.normalized_base_quantity := new.measured_base_quantity;
    else
      -- No pre-resolved quantity supplied (a lower-level/legacy ledger
      -- write that predates vendor-package awareness, e.g. a direct
      -- PURCHASE_RECEIPT insert bypassing post_purchase_document_
      -- inventory entirely) -- fall back to the same shared-row
      -- computation every other movement type already uses below,
      -- exactly as this trigger did before 20260811100121. This was a
      -- real regression: several pre-existing tests (and any other
      -- lower-level ledger write with the same shape) construct a
      -- PURCHASE_RECEIPT line directly and rely on this automatic
      -- computation -- requiring an explicit value unconditionally broke
      -- every one of them.
      if v_conversion_factor is null then
        raise exception 'inventory_item_id % has no conversion_factor defined for unit %',
          new.inventory_item_id, new.entered_unit_id;
      end if;
      new.normalized_base_quantity := new.entered_quantity * v_conversion_factor;
    end if;
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

