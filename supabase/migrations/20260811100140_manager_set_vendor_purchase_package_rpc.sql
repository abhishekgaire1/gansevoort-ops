-- Safe editing of confirmed items with inventory-impact protection (Part 5).
--
-- The FIRST standalone vendor-package management entry point: today
-- vendor_item_purchase_units can only be created/edited from inside
-- approve_line_classification_existing_item/new_item (20260811100120/
-- 100124/100126), both tied to a specific purchase-document line. This
-- RPC lets a manager edit a vendor/SKU's package for an ALREADY-
-- CONFIRMED item directly from the item workspace, independent of any
-- document. It performs its own validation, then delegates the actual
-- write to the existing, already-versioned upsert_vendor_item_purchase_
-- unit helper -- no supersede logic is duplicated here, and that helper
-- already writes its own VENDOR_PACKAGE_CONFIGURED audit event (a no-op
-- resubmission writes none, matching "only audit real changes").
--
-- This is a "future transactions only" change by construction: the
-- helper always supersedes (deactivate old + insert new), never mutates
-- a historical row, and 20260811100139's trigger reopens for review any
-- OPEN document line that had already confirmed against the version
-- being superseded -- posted documents are untouched either way.
create or replace function public.manager_set_vendor_purchase_package(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_vendor_item_mapping_id uuid,
  p_purchase_unit_code text,
  p_receiving_behavior text,
  p_conversion_factor numeric,
  p_requires_actual_measurement boolean
)
returns table (out_vendor_item_purchase_unit_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mapping record;
  v_item record;
  v_base_unit_code text;
  v_purchase_unit_id uuid;
  v_new_id uuid;
begin
  if p_receiving_behavior not in ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY') then
    raise exception 'invalid receiving behavior %', p_receiving_behavior
      using errcode = 'GA033';
  end if;

  select id, organization_id, vendor_id, inventory_item_id, is_active
    into v_mapping
    from public.vendor_item_mappings
   where id = p_vendor_item_mapping_id
     and organization_id = p_organization_id;

  if not found or not v_mapping.is_active then
    raise exception 'vendor item mapping % not found or no longer active in organization %', p_vendor_item_mapping_id, p_organization_id
      using errcode = 'GA051';
  end if;

  select id, disposition, approval_status, base_unit_id
    into v_item
    from public.inventory_items
   where id = v_mapping.inventory_item_id
     and organization_id = p_organization_id;

  if not found or v_item.disposition <> 'INVENTORY' or v_item.approval_status <> 'CONFIRMED' then
    raise exception 'inventory_item % is not a confirmed Item Master entry' , v_mapping.inventory_item_id
      using errcode = 'GA051';
  end if;

  select u.code into v_base_unit_code from public.units u where u.id = v_item.base_unit_id;
  select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
  if v_purchase_unit_id is null then
    raise exception 'unknown unit code %', p_purchase_unit_code
      using errcode = 'GA033';
  end if;

  if p_receiving_behavior = 'SAME_UNIT' then
    if p_purchase_unit_code <> v_base_unit_code or p_requires_actual_measurement then
      raise exception 'SAME_UNIT requires the purchase unit to equal the item''s base unit and no actual-measurement flag'
        using errcode = 'GA033';
    end if;
  elsif p_receiving_behavior = 'FIXED_CONVERSION' then
    if p_requires_actual_measurement
       or p_conversion_factor is null
       or p_conversion_factor <= 0
       or p_conversion_factor = 'NaN'::numeric
    then
      raise exception 'a positive, finite conversion factor is required for FIXED_CONVERSION'
        using errcode = 'GA079';
    end if;
  else
    -- MEASURE_EACH_DELIVERY / COUNT_EACH_DELIVERY
    if not p_requires_actual_measurement or p_conversion_factor is not null then
      raise exception '% requires an actual-measurement flag and no fixed conversion factor', p_receiving_behavior
        using errcode = 'GA079';
    end if;
  end if;

  v_new_id := public.upsert_vendor_item_purchase_unit(
    p_organization_id, p_vendor_item_mapping_id, v_mapping.vendor_id, v_mapping.inventory_item_id,
    v_purchase_unit_id, p_receiving_behavior, p_conversion_factor, p_requires_actual_measurement, p_app_user_id
  );

  return query select v_new_id;
end;
$$;

revoke all on function public.manager_set_vendor_purchase_package(uuid, uuid, uuid, text, text, numeric, boolean) from public;
grant execute on function public.manager_set_vendor_purchase_package(uuid, uuid, uuid, text, text, numeric, boolean) to service_role;
