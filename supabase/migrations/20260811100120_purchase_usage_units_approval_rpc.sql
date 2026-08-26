-- Purchase-versus-usage unit model: atomic approval RPC extensions.
--
-- Extends the existing new-item/existing-item approval RPCs (unchanged
-- signature prefix, so every existing call site keeps working once
-- updated to pass the new trailing params) to also configure:
--   - a primary (and optional secondary) kiosk usage unit, via
--     inventory_item_usage_units;
--   - a vendor/SKU-specific purchase package, via vendor_item_purchase_units,
--     keyed to the STABLE vendor_item_mappings identity rather than the
--     bare (item, unit code) pair inventory_item_units used before.
--
-- AI-proposed values are NEVER auto-applied here: both RPCs already only
-- ever receive the manager's OWN submitted values (the AI proposal lives
-- separately, in purchase_document_line_classifications.ai_proposed_purchase_unit,
-- until a manager's own approval call -- carrying the manager's confirmed
-- numbers -- reaches this function). Nothing here reads that AI-proposal
-- column as an input.
--
-- New app-defined SQLSTATEs (highest in use before this migration: GA061,
-- see 20260811100103/100104): GA062 SAME_LINE_DIFFERENT_ITEM_CONFLICT,
-- GA063 SECONDARY_USAGE_UNIT_NOT_DISTINCT, GA064 SECONDARY_USAGE_UNIT_INVALID_FACTOR,
-- GA065 NON_INVENTORY_ITEM_CANNOT_HAVE_USAGE_UNIT. These are freshly
-- allocated -- GA020/GA031-GA033 were considered and rejected because
-- purchase_document_line_classifications' own GA020 (STALE_REVIEW_PROPOSALS,
-- see app/lib/purchaseDocuments/errors.ts) and app/lib/inventory/errors.ts's
-- GA031/GA032 (cycle-count waste codes) already claim those.

-- ============================================================
-- 1. upsert_vendor_item_mapping now returns the mapping id
-- ============================================================
-- Changing a `returns void` function to return a value requires DROP +
-- CREATE (a bare CREATE OR REPLACE cannot change the return type). Every
-- existing caller uses `perform ...` (discarding the result), which works
-- identically against a function that now returns something -- this is a
-- non-breaking signature change for every existing call site.
drop function if exists public.upsert_vendor_item_mapping(uuid, uuid, text, text, text, uuid, uuid);

create or replace function public.upsert_vendor_item_mapping(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_match_basis text,
  p_vendor_sku text,
  p_normalized_description text,
  p_inventory_item_id uuid,
  p_confirmed_by_app_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_id uuid;
  v_existing_item_id uuid;
  v_had_existing boolean;
  v_new_id uuid;
begin
  select id, inventory_item_id into v_existing_id, v_existing_item_id
    from public.vendor_item_mappings
   where organization_id = p_organization_id
     and vendor_id = p_vendor_id
     and match_basis = p_match_basis
     and is_active
     and (p_match_basis <> 'VENDOR_SKU' or vendor_sku = p_vendor_sku)
     and (p_match_basis <> 'NORMALIZED_DESCRIPTION' or normalized_description = p_normalized_description);
  v_had_existing := found;

  if v_had_existing and v_existing_item_id = p_inventory_item_id then
    -- Already correctly mapped -- nothing to do.
    return v_existing_id;
  end if;

  v_new_id := gen_random_uuid();

  if v_had_existing then
    update public.vendor_item_mappings
       set is_active = false, superseded_by_mapping_id = v_new_id
     where id = v_existing_id;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_confirmed_by_app_user_id, 'VENDOR_ITEM_MAPPING_REMAPPED', 'vendor_item_mapping', v_new_id,
      jsonb_build_object('inventoryItemId', v_existing_item_id), jsonb_build_object('inventoryItemId', p_inventory_item_id));
  end if;

  insert into public.vendor_item_mappings (
    id, organization_id, vendor_id, match_basis, vendor_sku, normalized_description, inventory_item_id, confirmed_by_app_user_id
  ) values (
    v_new_id, p_organization_id, p_vendor_id, p_match_basis, p_vendor_sku, p_normalized_description, p_inventory_item_id, p_confirmed_by_app_user_id
  );

  return v_new_id;
end;
$$;

revoke all on function public.upsert_vendor_item_mapping(uuid, uuid, text, text, text, uuid, uuid) from public;
grant execute on function public.upsert_vendor_item_mapping(uuid, uuid, text, text, text, uuid, uuid) to service_role;

-- ============================================================
-- 2. Shared helper: create/version a vendor purchase package
-- ============================================================
-- Used by both approval RPCs below. Idempotent: an identical resubmission
-- (same unit/behavior/factor) is a no-op; a genuine change versions the
-- package (deactivate + supersede), exactly like vendor_item_mappings'
-- own remap pattern -- never an in-place UPDATE of a historical factor.
-- IMPORTANT: inventory_movement_lines_item_unit_fk (20260811100005) is a
-- real FOREIGN KEY, not an application check -- ANY entered_unit_id ever
-- posted for an item, including a vendor's purchase unit, MUST have a
-- matching (inventory_item_id, unit_id) row in inventory_item_units, or
-- posting a receipt in that unit is physically impossible. This function
-- therefore still ensures such a row exists ("vestigial" once a vendor
-- package is configured -- present ONLY to satisfy that FK). Its
-- conversion_factor is NEVER authoritative for posting arithmetic once a
-- vendor_item_purchase_units row exists: post_purchase_document_inventory
-- (20260811100123) resolves the REAL, vendor-scoped factor itself and
-- passes an already-computed base quantity through, so two vendors (or
-- two SKUs) sharing a unit code can never collide on the number that
-- actually matters, even though they necessarily share this one
-- FK-satisfying row.
create or replace function public.upsert_vendor_item_purchase_unit(
  p_organization_id uuid,
  p_vendor_item_mapping_id uuid,
  p_vendor_id uuid,
  p_inventory_item_id uuid,
  p_purchase_unit_id uuid,
  p_receiving_behavior text,
  p_conversion_factor numeric,
  p_requires_actual_measurement boolean,
  p_app_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_new_id uuid;
begin
  if not exists (
    select 1 from public.inventory_item_units where inventory_item_id = p_inventory_item_id and unit_id = p_purchase_unit_id
  ) then
    insert into public.inventory_item_units (
      inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
    ) values (
      p_inventory_item_id, p_purchase_unit_id, p_conversion_factor, p_requires_actual_measurement, false, true
    );
  else
    update public.inventory_item_units
       set conversion_factor = p_conversion_factor, requires_actual_measurement = p_requires_actual_measurement, is_active = true
     where inventory_item_id = p_inventory_item_id and unit_id = p_purchase_unit_id;
  end if;

  select id, purchase_unit_id, receiving_behavior, conversion_factor, requires_actual_measurement
    into v_existing
    from public.vendor_item_purchase_units
   where organization_id = p_organization_id
     and vendor_item_mapping_id = p_vendor_item_mapping_id
     and is_active;

  if found
     and v_existing.purchase_unit_id = p_purchase_unit_id
     and v_existing.receiving_behavior = p_receiving_behavior
     and v_existing.conversion_factor is not distinct from p_conversion_factor
     and v_existing.requires_actual_measurement = p_requires_actual_measurement
  then
    -- Identical resubmission -- idempotent no-op.
    return v_existing.id;
  end if;

  v_new_id := gen_random_uuid();

  if found then
    update public.vendor_item_purchase_units
       set is_active = false, effective_to = now(), superseded_by_purchase_unit_id = v_new_id
     where id = v_existing.id;
  end if;

  insert into public.vendor_item_purchase_units (
    id, organization_id, vendor_item_mapping_id, vendor_id, inventory_item_id,
    purchase_unit_id, receiving_behavior, conversion_factor, requires_actual_measurement,
    confirmed_by_app_user_id
  ) values (
    v_new_id, p_organization_id, p_vendor_item_mapping_id, p_vendor_id, p_inventory_item_id,
    p_purchase_unit_id, p_receiving_behavior, p_conversion_factor, p_requires_actual_measurement,
    p_app_user_id
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'VENDOR_PACKAGE_CONFIGURED', 'vendor_item_purchase_unit', v_new_id,
    jsonb_build_object(
      'vendorItemMappingId', p_vendor_item_mapping_id, 'purchaseUnitId', p_purchase_unit_id,
      'receivingBehavior', p_receiving_behavior, 'conversionFactor', p_conversion_factor,
      'requiresActualMeasurement', p_requires_actual_measurement,
      'supersededPackageId', case when found then v_existing.id else null end
    ));

  return v_new_id;
end;
$$;

revoke all on function public.upsert_vendor_item_purchase_unit(uuid, uuid, uuid, uuid, uuid, text, numeric, boolean, uuid) from public;
grant execute on function public.upsert_vendor_item_purchase_unit(uuid, uuid, uuid, uuid, uuid, text, numeric, boolean, uuid) to service_role;

-- ============================================================
-- 3. Shared helper: create/reconfigure a secondary kiosk usage slot
-- ============================================================
-- Slot 1 (primary) is always the item's base-unit row and is ensured by
-- the caller before this runs. This helper only ever manages slot 2, and
-- only ever points it at a FIXED-CONVERSION unit (enforced by the
-- inventory_item_usage_units_enforce_fixed_conversion trigger -- this
-- function never sets requires_actual_measurement itself, so it cannot
-- accidentally create a measured kiosk unit).
create or replace function public.upsert_secondary_usage_unit(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_secondary_unit_code text,
  p_secondary_conversion_factor numeric,
  p_app_user_id uuid
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

  if p_secondary_conversion_factor is null or p_secondary_conversion_factor <= 0 then
    raise exception 'a positive conversion factor is required for the secondary usage unit' using errcode = 'GA064';
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

  -- Ensure the (item, unit) conversion row exists -- fixed conversion
  -- only, never measured, never is_default_entry_unit (slot 1 already
  -- claims that).
  select id into v_iiu_id from public.inventory_item_units
   where inventory_item_id = p_inventory_item_id and unit_id = v_secondary_unit_id;

  if v_iiu_id is null then
    insert into public.inventory_item_units (
      inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
    ) values (
      p_inventory_item_id, v_secondary_unit_id, p_secondary_conversion_factor, false, false, true
    ) returning id into v_iiu_id;
  else
    update public.inventory_item_units
       set conversion_factor = p_secondary_conversion_factor, requires_actual_measurement = false, is_active = true
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

revoke all on function public.upsert_secondary_usage_unit(uuid, uuid, text, numeric, uuid) from public;
grant execute on function public.upsert_secondary_usage_unit(uuid, uuid, text, numeric, uuid) to service_role;

-- ============================================================
-- 4. approve_line_classification_new_item -- extended
-- ============================================================
drop function if exists public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric
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
  p_secondary_conversion_factor numeric default null
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
      perform public.upsert_secondary_usage_unit(p_organization_id, v_item_id, p_secondary_usage_unit_code, p_secondary_conversion_factor, p_app_user_id);
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
      perform public.upsert_vendor_item_purchase_unit(
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
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, p_disposition,
    v_item_id, p_spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_APPROVED', 'inventory_item', v_item_id,
    jsonb_build_object(
      'name', p_final_name, 'disposition', p_disposition,
      'purchaseUnitCode', p_purchase_unit_code, 'receivingBehavior', p_receiving_behavior, 'fixedConversionFactor', p_fixed_conversion_factor,
      'secondaryUsageUnitCode', p_secondary_usage_unit_code, 'secondaryConversionFactor', p_secondary_conversion_factor
    ));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item_id, 'newItem', true));

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric
) from public;
grant execute on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric
) to service_role;

-- ============================================================
-- 5. approve_line_classification_existing_item -- extended
-- ============================================================
-- A known canonical item receiving a new vendor SKU can now register that
-- vendor's own purchase package without touching any other vendor's or
-- SKU's configuration -- the missing capability the audit identified.
--
-- The prior signature (6 params, no purchase-unit trailing args) must be
-- DROPPED first: adding new trailing defaulted params via a bare CREATE
-- OR REPLACE creates a second, ambiguous overload rather than replacing
-- the function -- the exact bug already fixed twice in this codebase for
-- approve_line_classification_new_item (20260811100052, 20260811100062).
drop function if exists public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean);

create or replace function public.approve_line_classification_existing_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_remember_vendor_mapping boolean default true,
  p_purchase_unit_code text default null,
  p_receiving_behavior text default null,
  p_fixed_conversion_factor numeric default null
)
returns table (
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_item record;
  v_vendor_id uuid;
  v_classification_id uuid;
  v_purchase_document record;
  v_base_unit_code text;
  v_purchase_unit_id uuid;
  v_mapping_id uuid;
begin
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

  if p_receiving_behavior is not null and p_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid receiving behavior %', p_receiving_behavior;
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

  select id, disposition, spend_category_id into v_item
    from public.inventory_items
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if p_purchase_unit_code is not null and v_item.disposition = 'INVENTORY' and v_vendor_id is not null then
    select u.code into v_base_unit_code
      from public.inventory_items ii join public.units u on u.id = ii.base_unit_id
     where ii.id = p_inventory_item_id;

    if p_purchase_unit_code <> v_base_unit_code then
      select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
      if v_purchase_unit_id is null then
        raise exception 'unknown unit code %', p_purchase_unit_code;
      end if;
      if p_receiving_behavior = 'FIXED_CONVERSION' and (p_fixed_conversion_factor is null or p_fixed_conversion_factor <= 0) then
        raise exception 'a positive fixed_conversion_factor is required for FIXED_CONVERSION';
      end if;
    end if;
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  if v_purchase_unit_id is not null and p_receiving_behavior is distinct from 'SAME_UNIT' then
    if v_line.vendor_sku is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id);
    elsif v_line.description is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item.id, p_app_user_id
      );
    end if;

    if v_mapping_id is not null then
      perform public.upsert_vendor_item_purchase_unit(
        p_organization_id, v_mapping_id, v_vendor_id, v_item.id, v_purchase_unit_id, p_receiving_behavior,
        case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
        p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY'),
        p_app_user_id
      );
    end if;
  elsif p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id);
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item.id, p_app_user_id
      );
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item.id, 'newItem', false));

  return query select v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean, text, text, numeric) from public;
grant execute on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean, text, text, numeric) to service_role;
