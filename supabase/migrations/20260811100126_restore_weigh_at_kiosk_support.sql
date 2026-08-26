-- Approved product decision: restore safe weigh-at-kiosk support.
--
-- 20260811100119 added enforce_usage_unit_fixed_conversion (trigger
-- GA030), which unconditionally forbade any unit requiring actual
-- measurement from ever being registered as a kiosk usage unit (primary
-- or secondary), and 20260811100121's enforce_movement_line_measurement
-- independently mirrored that same exclusion in its withdrawal-time
-- kiosk-authorization check. Together these silently broke the
-- pre-existing "weigh at kiosk" withdrawal capability
-- (inventory_item_units.requires_actual_measurement, live since
-- 20260811100005) for every item whose measured unit a manager would
-- otherwise want to confirm for kiosk use -- confirmed directly: several
-- pre-100119 tests exercising a measured BOX unit now either fail the
-- GA030 registration check or, once that's bypassed, still hit GA066 at
-- withdrawal time.
--
-- This migration is additive/forward-only -- 100119-100125 are already
-- applied and are not edited. It:
--   1. Removes enforce_usage_unit_fixed_conversion/GA030 entirely (it had
--      no other job).
--   2. Removes the matching exclusion from enforce_movement_line_
--      measurement's kiosk-authorization check (body-only replace, no
--      signature change).
--   3. Extends upsert_secondary_usage_unit / manager_add_secondary_
--      usage_unit / approve_line_classification_new_item with a new
--      trailing p_requires_actual_measurement / p_secondary_requires_
--      measurement boolean (default false, fully backward compatible in
--      behavior) so a manager can explicitly confirm a MEASURED
--      secondary usage unit, not only a fixed-conversion one. Each
--      extended function is DROPPED before being recreated (not a bare
--      CREATE OR REPLACE) -- adding a new parameter via a bare replace
--      would create a second, ambiguous overload rather than replacing
--      the existing one (the exact hazard 20260811100120's own comment
--      already documents and avoids for approve_line_classification_
--      existing_item); since nothing outside this migration's own
--      TypeScript callers (updated in the same commit) depends on the
--      old signatures, dropping first is correct here, not merely safe.
--
-- What remains unchanged, by design:
--   - Fixed-conversion registration/withdrawal behavior (p_requires_
--     actual_measurement / p_secondary_requires_measurement default to
--     false; omitting them reproduces prior behavior exactly).
--   - measured_base_quantity's own validation (positive, and NUMERIC
--     can never hold NaN/Infinity at the type level) -- unchanged since
--     20260811100005; this migration does not touch that check
--     constraint or the general (non-ISSUE_TO_STATION-authorization)
--     measurement-vs-fixed branch of enforce_movement_line_measurement.
--   - Vendor purchase packages (vendor_item_purchase_units) have no
--     path into inventory_item_usage_units at all -- confirmed by
--     inspection, not merely assumed -- so a vendor package requiring
--     measurement can never become a kiosk usage unit "merely because it
--     requires measurement"; only an explicit manager_add_secondary_
--     usage_unit / approve_line_classification_new_item call, naming a
--     plain unit code, ever writes to that table.

-- ============================================================
-- 1. Remove the GA030 registration-time restriction entirely
-- ============================================================
drop trigger if exists inventory_item_usage_units_enforce_fixed_conversion on public.inventory_item_usage_units;
drop function if exists public.enforce_usage_unit_fixed_conversion();

-- ============================================================
-- 2. Remove the matching withdrawal-time exclusion
-- ============================================================
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

  -- Kiosk-usage authorization: a withdrawal must use a unit that is
  -- SPECIFICALLY an active kiosk usage slot for this item -- never merely
  -- "active" in inventory_item_units, which a vendor purchase-only unit
  -- also satisfies. This is the database-level guarantee the audit found
  -- missing: the client's own choice of unit is never trusted alone.
  --
  -- 20260811100126: a measured usage unit is now an authorized slot too
  -- (approved product decision -- weigh-at-kiosk support). This EXISTS
  -- check no longer excludes requires_actual_measurement -- the exclusion
  -- lived here ONLY as a defense-in-depth mirror of the registration-time
  -- GA030 restriction (20260811100119's enforce_usage_unit_fixed_conversion),
  -- which 100126 also removes; a measured unit reaching this point is
  -- either the item's own base unit (self-referencing, conversion_factor
  -- irrelevant) or a slot a manager explicitly, separately confirmed via
  -- manager_add_secondary_usage_unit/upsert_secondary_usage_unit with
  -- p_requires_actual_measurement = true -- never something a vendor
  -- purchase package (upsert_vendor_item_purchase_unit, a completely
  -- separate table with no path into inventory_item_usage_units) can
  -- reach on its own. Whether the withdrawal ITSELF is well-formed for a
  -- measured unit (a positive, supplied measured_base_quantity; no
  -- supplied value for a fixed unit) is enforced below, unchanged.
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

-- ============================================================
-- 3. upsert_secondary_usage_unit -- measured secondary support
-- ============================================================
drop function if exists public.upsert_secondary_usage_unit(uuid, uuid, text, numeric, uuid);

create or replace function public.upsert_secondary_usage_unit(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_secondary_unit_code text,
  p_secondary_conversion_factor numeric,
  p_app_user_id uuid,
  p_requires_actual_measurement boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_unit_code text;
  v_secondary_unit_id uuid;
  v_iiu_id uuid;
  v_existing_slot record;
begin
  select u.code into v_base_unit_code
    from public.inventory_items ii
    join public.units u on u.id = ii.base_unit_id
   where ii.id = p_inventory_item_id and ii.organization_id = p_organization_id;

  if v_base_unit_code is null then
    raise exception 'inventory_item % has no resolvable base unit', p_inventory_item_id;
  end if;

  if p_secondary_unit_code = v_base_unit_code then
    raise exception 'the secondary usage unit must be different from the base unit' using errcode = 'GA063';
  end if;

  -- Fixed-conversion (default) and measure-at-withdrawal are mutually
  -- exclusive, exactly mirroring inventory_item_units' own long-standing
  -- invariant (20260811100005): a positive factor XOR a measurement
  -- requirement, never both, never neither. Approved product decision --
  -- weigh-at-kiosk support (20260811100126): a secondary usage unit may
  -- now be registered as measured, with no factor at all -- the employee
  -- supplies the actual measured base quantity at withdrawal time
  -- instead (enforce_movement_line_measurement, unchanged logic).
  if p_requires_actual_measurement then
    if p_secondary_conversion_factor is not null then
      raise exception 'a measured secondary usage unit must not also supply a conversion factor' using errcode = 'GA064';
    end if;
  else
    if p_secondary_conversion_factor is null or p_secondary_conversion_factor <= 0 then
      raise exception 'a positive conversion factor is required for the secondary usage unit' using errcode = 'GA064';
    end if;
  end if;

  select id into v_secondary_unit_id from public.units where code = p_secondary_unit_code;
  if v_secondary_unit_id is null then
    raise exception 'unknown unit code %', p_secondary_unit_code;
  end if;

  if exists (
    select 1 from public.inventory_item_usage_units iu
     where iu.organization_id = p_organization_id
       and iu.inventory_item_id = p_inventory_item_id
       and iu.usage_slot = 1
       and iu.is_active
       and iu.inventory_item_unit_id in (
         select id from public.inventory_item_units where inventory_item_id = p_inventory_item_id and unit_id = v_secondary_unit_id
       )
  ) then
    raise exception 'the secondary usage unit cannot be the same unit as the primary' using errcode = 'GA063';
  end if;

  -- Ensure the (item, unit) conversion row exists -- never
  -- is_default_entry_unit (slot 1 already claims that) -- fixed
  -- conversion or measured per p_requires_actual_measurement above.
  select id into v_iiu_id from public.inventory_item_units
   where inventory_item_id = p_inventory_item_id and unit_id = v_secondary_unit_id;

  if v_iiu_id is null then
    insert into public.inventory_item_units (
      inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
    ) values (
      p_inventory_item_id, v_secondary_unit_id, p_secondary_conversion_factor, p_requires_actual_measurement, false, true
    ) returning id into v_iiu_id;
  else
    update public.inventory_item_units
       set conversion_factor = p_secondary_conversion_factor, requires_actual_measurement = p_requires_actual_measurement, is_active = true
     where id = v_iiu_id;
  end if;

  select id, inventory_item_unit_id into v_existing_slot
    from public.inventory_item_usage_units
   where organization_id = p_organization_id
     and inventory_item_id = p_inventory_item_id
     and usage_slot = 2
     and is_active;

  if found and v_existing_slot.inventory_item_unit_id = v_iiu_id then
    -- Already configured exactly this way -- idempotent no-op, just
    -- refresh the confirmation stamp.
    update public.inventory_item_usage_units
       set confirmed_by_app_user_id = p_app_user_id, confirmed_at = now()
     where id = v_existing_slot.id;
    return v_existing_slot.id;
  end if;

  declare
    v_new_slot_id uuid := gen_random_uuid();
  begin
    if found then
      update public.inventory_item_usage_units
         set is_active = false, superseded_by_usage_unit_id = v_new_slot_id
       where id = v_existing_slot.id;
    end if;

    insert into public.inventory_item_usage_units (
      id, organization_id, inventory_item_id, inventory_item_unit_id, usage_slot, is_active, confirmed_by_app_user_id, confirmed_at
    ) values (
      v_new_slot_id, p_organization_id, p_inventory_item_id, v_iiu_id, 2, true, p_app_user_id, now()
    );

    return v_new_slot_id;
  end;
end;
$$;


revoke all on function public.upsert_secondary_usage_unit(uuid, uuid, text, numeric, uuid, boolean) from public;
grant execute on function public.upsert_secondary_usage_unit(uuid, uuid, text, numeric, uuid, boolean) to service_role;

-- ============================================================
-- 4. manager_add_secondary_usage_unit -- threads the new mode through
-- ============================================================
drop function if exists public.manager_add_secondary_usage_unit(uuid, uuid, uuid, text, numeric);

create or replace function public.manager_add_secondary_usage_unit(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_secondary_unit_code text,
  p_secondary_conversion_factor numeric,
  p_requires_actual_measurement boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_result uuid;
begin
  select id, disposition, approval_status into v_item
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = p_organization_id;

  if not found then
    raise exception 'inventory_item % not found in organization %', p_inventory_item_id, p_organization_id
      using errcode = 'GA009';
  end if;

  if v_item.disposition <> 'INVENTORY' or v_item.approval_status <> 'CONFIRMED' then
    raise exception 'inventory_item % is not a confirmed inventory item' , p_inventory_item_id
      using errcode = 'GA009';
  end if;

  if not exists (
    select 1 from public.inventory_item_usage_units
     where organization_id = p_organization_id and inventory_item_id = p_inventory_item_id and usage_slot = 1 and is_active
  ) then
    raise exception 'inventory_item % has no active primary usage unit to add a secondary alongside', p_inventory_item_id
      using errcode = 'GA067';
  end if;

  v_result := public.upsert_secondary_usage_unit(
    p_organization_id, p_inventory_item_id, p_secondary_unit_code, p_secondary_conversion_factor, p_app_user_id, p_requires_actual_measurement
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_SECONDARY_USAGE_UNIT_CONFIGURED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object(
      'secondaryUnitCode', p_secondary_unit_code, 'secondaryConversionFactor', p_secondary_conversion_factor,
      'requiresActualMeasurement', p_requires_actual_measurement, 'usageUnitId', v_result
    ));

  return v_result;
end;
$$;

revoke all on function public.manager_add_secondary_usage_unit(uuid, uuid, uuid, text, numeric, boolean) from public;
grant execute on function public.manager_add_secondary_usage_unit(uuid, uuid, uuid, text, numeric, boolean) to service_role;

-- ============================================================
-- 5. approve_line_classification_new_item -- initial secondary usage
--    unit may also be configured as measured at approval time
-- ============================================================
drop function if exists public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric
);

create or replace function public.approve_line_classification_new_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_final_name text,
  p_disposition text,
  p_category_id uuid,
  p_spend_category_id uuid,
  p_base_unit_code text,
  p_pending_item_id uuid default null,
  p_remember_vendor_mapping boolean default true,
  p_purchase_unit_code text default null,
  p_receiving_behavior text default null,
  p_fixed_conversion_factor numeric default null,
  p_secondary_usage_unit_code text default null,
  p_secondary_conversion_factor numeric default null,
  p_secondary_requires_measurement boolean default false
)
returns table (
  out_inventory_item_id uuid,
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_base_unit_id uuid;
  v_base_iiu_id uuid;
  v_purchase_unit_id uuid;
  v_line record;
  v_classification_id uuid;
  v_vendor_id uuid;
  v_purchase_document record;
  v_duplicate record;
  v_vendor_item_purchase_unit_id uuid;
  v_existing_classification record;
  v_mapping_id uuid;
begin
  if p_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid disposition %', p_disposition;
  end if;

  if p_spend_category_id is null then
    raise exception 'a spend category is required to confirm a new item' using errcode = 'GA013';
  end if;

  if p_receiving_behavior is not null and p_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid receiving behavior %', p_receiving_behavior;
  end if;

  if p_disposition <> 'INVENTORY' and p_secondary_usage_unit_code is not null then
    raise exception 'a non-inventory item cannot have a kiosk usage unit configuration' using errcode = 'GA065';
  end if;

  select status, created_by_app_user_id into v_purchase_document
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_purchase_document.status = 'DRAFT' and v_purchase_document.created_by_app_user_id is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not approve item classifications on its draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  if v_purchase_document.status = 'READY_FOR_VERIFICATION' then
    if v_purchase_document.created_by_app_user_id = p_app_user_id then
      raise exception 'app_user % prepared purchase_document % and cannot review-correct its item resolution', p_app_user_id, p_purchase_document_id
        using errcode = 'GA004';
    end if;
    if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
      raise exception 'purchase_document % is in final review: reviewer item-resolution corrections are proposals applied atomically by Final Verify, never direct writes', p_purchase_document_id
        using errcode = 'GA003';
    end if;
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
  end if;

  select vendor_sku, description, package_unit, measured_unit
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;

  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  -- Same-key/different-payload replay protection: if this exact line was
  -- already confirmed against a DIFFERENT item than this call would
  -- resolve to, fail closed rather than silently reassigning a completed
  -- approval. A pure retry (same pending_item_id / same freshly-resolved
  -- item) is unaffected -- it proceeds and lands on the same idempotent
  -- state via the ON CONFLICT below.
  select inventory_item_id, status into v_existing_classification
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  if found and v_existing_classification.status = 'CONFIRMED'
     and v_existing_classification.inventory_item_id is distinct from p_pending_item_id
     and p_pending_item_id is not null
  then
    raise exception 'line % was already confirmed against a different item; reopen it before resubmitting different values', p_line_key
      using errcode = 'GA062';
  end if;

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if p_disposition = 'INVENTORY' then
    select id into v_base_unit_id from public.units where code = p_base_unit_code;
    if v_base_unit_id is null then
      raise exception 'unknown unit code %', p_base_unit_code;
    end if;
  end if;

  if p_disposition = 'INVENTORY' and p_purchase_unit_code is not null and p_purchase_unit_code <> p_base_unit_code then
    select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
    if v_purchase_unit_id is null then
      raise exception 'unknown unit code %', p_purchase_unit_code;
    end if;

    if p_receiving_behavior = 'FIXED_CONVERSION' and (p_fixed_conversion_factor is null or p_fixed_conversion_factor <= 0) then
      raise exception 'a positive fixed_conversion_factor is required for FIXED_CONVERSION';
    end if;
  end if;

  select id, name into v_duplicate
    from public.inventory_items
   where organization_id = p_organization_id
     and status = 'active'
     and approval_status = 'CONFIRMED'
     and public.normalize_item_name(name) = public.normalize_item_name(p_final_name)
     and id is distinct from coalesce(p_pending_item_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if found then
    raise exception 'an active item named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA016', detail = jsonb_build_object('existingItemId', v_duplicate.id, 'existingItemName', v_duplicate.name)::text;
  end if;

  if p_pending_item_id is not null then
    update public.inventory_items as ii
       set name = p_final_name,
           disposition = p_disposition,
           category_id = case when p_disposition = 'INVENTORY' then p_category_id else null end,
           spend_category_id = p_spend_category_id,
           base_unit_id = v_base_unit_id,
           approval_status = 'CONFIRMED'
     where ii.id = p_pending_item_id
       and ii.organization_id = p_organization_id
       and ii.approval_status = 'PENDING_REVIEW'
     returning ii.id into v_item_id;

    if not found then
      raise exception 'inventory_item % is not a pending proposal', p_pending_item_id
        using errcode = 'GA009';
    end if;
  else
    v_item_id := gen_random_uuid();
    insert into public.inventory_items (
      id, organization_id, category_id, name, base_unit_id, status,
      disposition, spend_category_id, approval_status, created_via
    ) values (
      v_item_id, p_organization_id,
      case when p_disposition = 'INVENTORY' then p_category_id else null end,
      p_final_name, v_base_unit_id, 'active',
      p_disposition, p_spend_category_id, 'CONFIRMED', 'MANUAL'
    );
  end if;

  -- Base-unit conversion row (unchanged from before this migration).
  if p_disposition = 'INVENTORY' then
    select id into v_base_iiu_id from public.inventory_item_units
     where inventory_item_id = v_item_id and unit_id = v_base_unit_id;

    if v_base_iiu_id is null then
      insert into public.inventory_item_units (
        inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
      ) values (
        v_item_id, v_base_unit_id, 1, false, true, true
      ) returning id into v_base_iiu_id;
    end if;

    -- Primary kiosk usage slot -- always the base-unit row, always slot 1.
    if not exists (
      select 1 from public.inventory_item_usage_units
       where organization_id = p_organization_id and inventory_item_id = v_item_id and usage_slot = 1 and is_active
    ) then
      insert into public.inventory_item_usage_units (
        organization_id, inventory_item_id, inventory_item_unit_id, usage_slot, is_active, confirmed_by_app_user_id, confirmed_at
      ) values (
        p_organization_id, v_item_id, v_base_iiu_id, 1, true, p_app_user_id, now()
      );
    end if;

    if p_secondary_usage_unit_code is not null then
      perform public.upsert_secondary_usage_unit(
        p_organization_id, v_item_id, p_secondary_usage_unit_code, p_secondary_conversion_factor, p_app_user_id, p_secondary_requires_measurement
      );
    end if;
  end if;

  -- Vendor purchase package -- keyed to the vendor-SKU identity, never
  -- the bare (item, unit) pair, so a second vendor (or a second SKU from
  -- the same vendor) can never collide with this one.
  if v_purchase_unit_id is not null and p_receiving_behavior is distinct from 'SAME_UNIT' and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id);
    elsif v_line.description is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;

    if v_mapping_id is not null then
      v_vendor_item_purchase_unit_id := public.upsert_vendor_item_purchase_unit(
        p_organization_id, v_mapping_id, v_vendor_id, v_item_id, v_purchase_unit_id, p_receiving_behavior,
        case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
        p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY'),
        p_app_user_id
      );
    end if;
  elsif p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id);
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at, vendor_item_purchase_unit_id
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, p_disposition,
    v_item_id, p_spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now(), v_vendor_item_purchase_unit_id
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at,
    vendor_item_purchase_unit_id = excluded.vendor_item_purchase_unit_id
  returning id into v_classification_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_APPROVED', 'inventory_item', v_item_id,
    jsonb_build_object(
      'name', p_final_name, 'disposition', p_disposition,
      'purchaseUnitCode', p_purchase_unit_code, 'receivingBehavior', p_receiving_behavior, 'fixedConversionFactor', p_fixed_conversion_factor,
      'secondaryUsageUnitCode', p_secondary_usage_unit_code, 'secondaryConversionFactor', p_secondary_conversion_factor,
      'secondaryRequiresMeasurement', p_secondary_requires_measurement
    ));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item_id, 'newItem', true));

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric, boolean
) from public;
grant execute on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric, boolean
) to service_role;

