-- Safe editing of confirmed items with inventory-impact protection
-- (Part 11) -- bug fix, found by this feature's own test suite before
-- shipping.
--
-- correct_receipt_package_factor's movement_line insert used
-- entered_unit_id = v_new_vpu.purchase_unit_id (the vendor's PACKAGE
-- unit, e.g. CASE) together with entered_quantity = abs(v_delta) -- but
-- v_delta is already a BASE-unit quantity (new_quantity - posted_base_
-- quantity, both computed in the item's base unit). Pairing a base-unit
-- number with a package-unit id is wrong on its face, and
-- enforce_movement_line_measurement (20260811100126) then recomputes
-- normalized_base_quantity = entered_quantity * inventory_item_units'
-- shared conversion_factor for that package unit -- silently multiplying
-- an already-in-base-units delta by the package factor AGAIN. Caught by
-- tests/inventoryCorrections.rpc.test.ts before this ever reached DEV
-- application code: a factor correction from 24 to 30 on a 2-case
-- receipt (expected delta +12, new balance 60) instead produced a
-- movement line of 12 * 30 = 360, landing on 408.
--
-- Fix: entered_unit_id must be the item's own base unit (self-
-- referencing in inventory_item_units with conversion_factor = 1, same
-- as record_inventory_correction, 20260811100141, already correctly
-- does) so the trigger's recomputation is a no-op multiply-by-one.
-- Body-only replace; no signature, validation, or audit-shape change.
create or replace function public.correct_receipt_package_factor(
  p_app_user_id uuid,
  p_organization_id uuid,
  p_posting_line_ids uuid[],
  p_new_vendor_item_purchase_unit_id uuid,
  p_reason text,
  p_client_request_id uuid
) returns table (
  out_correction_ids uuid[],
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_new_vpu record;
  v_posting_line_id uuid;
  v_row_key text;
  v_existing_count integer;
  v_total_count integer;
  v_result_ids uuid[] := '{}';
  v_lock_key bigint;
  v_pl record;
  v_previous_vpu_id uuid;
  v_actual_received numeric;
  v_new_quantity numeric;
  v_delta numeric;
  v_movement_id uuid;
  v_line_id uuid;
  v_correction_id uuid;
  v_existing_id uuid;
  v_base_unit_id uuid;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;
  if p_posting_line_ids is null or array_length(p_posting_line_ids, 1) is null then
    raise exception 'p_posting_line_ids must contain at least one id';
  end if;

  if not exists (
    select 1 from public.app_users au
     where au.id = p_app_user_id and au.organization_id = p_organization_id and au.is_active
  ) then
    raise exception 'app_user_id % is not an active app user in organization %', p_app_user_id, p_organization_id
      using errcode = 'GA081';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'a reason is required for a receipt correction'
      using errcode = 'GA033';
  end if;

  select id, conversion_factor, requires_actual_measurement, purchase_unit_id
    into v_new_vpu
    from public.vendor_item_purchase_units
   where id = p_new_vendor_item_purchase_unit_id and organization_id = p_organization_id;
  if not found then
    raise exception 'vendor_item_purchase_unit % not found in organization %', p_new_vendor_item_purchase_unit_id, p_organization_id
      using errcode = 'GA081';
  end if;
  if v_new_vpu.requires_actual_measurement
     or v_new_vpu.conversion_factor is null
     or v_new_vpu.conversion_factor <= 0
     or v_new_vpu.conversion_factor = 'NaN'::numeric
  then
    raise exception 'the target package version must have a positive, finite fixed conversion factor -- a measured-receiving package cannot be used for a factor correction'
      using errcode = 'GA079';
  end if;

  -- Idempotency: check every posting line's own composite key up front.
  v_total_count := array_length(p_posting_line_ids, 1);
  v_existing_count := 0;
  foreach v_posting_line_id in array p_posting_line_ids loop
    v_row_key := p_client_request_id::text || ':' || v_posting_line_id::text;
    select id into v_existing_id from public.inventory_corrections
     where organization_id = p_organization_id and client_request_id = v_row_key;
    if found then
      v_existing_count := v_existing_count + 1;
      v_result_ids := array_append(v_result_ids, v_existing_id);
    end if;
  end loop;

  if v_existing_count = v_total_count then
    return query select v_result_ids, true;
    return;
  end if;
  if v_existing_count > 0 then
    raise exception 'client_request_id % was already partially used with a different posting-line set', p_client_request_id
      using errcode = 'GA029';
  end if;
  v_result_ids := '{}';

  -- Lock every distinct (item, location) pair touched by this batch,
  -- deterministically ordered -- same discipline as complete_cycle_count.
  for v_lock_key in
    select distinct public.inventory_location_lock_key(p_organization_id, pl.inventory_item_id, pl.location_id)
      from public.purchase_document_inventory_posting_lines pl
     where pl.id = any(p_posting_line_ids) and pl.organization_id = p_organization_id
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  foreach v_posting_line_id in array p_posting_line_ids loop
    select pl.id, pl.organization_id, pl.inventory_item_id, pl.location_id, pl.posted_base_quantity, pl.receipt_line_id
      into v_pl
      from public.purchase_document_inventory_posting_lines pl
     where pl.id = v_posting_line_id;

    if not found or v_pl.organization_id <> p_organization_id then
      raise exception 'posting_line % not found in organization %', v_posting_line_id, p_organization_id
        using errcode = 'GA081';
    end if;

    select rl.actual_received_package_quantity, c.vendor_item_purchase_unit_id
      into v_actual_received, v_previous_vpu_id
      from public.receipt_lines rl
      join public.receipts r on r.id = rl.receipt_id
      join public.purchase_document_line_classifications c
        on c.organization_id = rl.organization_id
       and c.purchase_document_id = r.purchase_document_id
       and c.line_key = rl.matched_line_key
     where rl.id = v_pl.receipt_line_id;

    if not found or v_actual_received is null then
      raise exception 'posting_line % has no resolvable original received quantity', v_posting_line_id
        using errcode = 'GA081';
    end if;

    select base_unit_id into v_base_unit_id from public.inventory_items where id = v_pl.inventory_item_id;

    v_new_quantity := v_actual_received * v_new_vpu.conversion_factor;
    v_delta := v_new_quantity - v_pl.posted_base_quantity;
    v_row_key := p_client_request_id::text || ':' || v_posting_line_id::text;

    if v_delta = 0 then
      v_movement_id := null;
      v_line_id := null;
    else
      insert into public.inventory_movements (
        organization_id, location_id, station_id, movement_type,
        performed_by_app_user_id, business_date, notes, location_attribution
      ) values (
        p_organization_id, v_pl.location_id, null,
        case when v_delta > 0 then 'INVENTORY_CORRECTION_IN' else 'INVENTORY_CORRECTION_OUT' end,
        p_app_user_id, current_date, v_reason, 'EXACT'
      ) returning id into v_movement_id;

      -- Fixed: entered_unit_id is the item's OWN base unit (self-
      -- referencing conversion_factor = 1), never the vendor's package
      -- unit -- v_delta is already a base-unit quantity.
      insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id)
      values (v_movement_id, v_pl.inventory_item_id, abs(v_delta), v_base_unit_id)
      returning id into v_line_id;
    end if;

    begin
      insert into public.inventory_corrections (
        organization_id, correction_type, inventory_item_id, location_id,
        movement_id, movement_line_id, source_posting_line_id,
        previous_vendor_item_purchase_unit_id, new_vendor_item_purchase_unit_id,
        previous_quantity, new_quantity, quantity_delta,
        reason, performed_by_app_user_id, client_request_id
      ) values (
        p_organization_id, 'RECEIPT_PACKAGE_FACTOR', v_pl.inventory_item_id, v_pl.location_id,
        v_movement_id, v_line_id, v_pl.id,
        v_previous_vpu_id, p_new_vendor_item_purchase_unit_id,
        v_pl.posted_base_quantity, v_new_quantity, v_delta,
        v_reason, p_app_user_id, v_row_key
      ) returning id into v_correction_id;
    exception when unique_violation then
      select id into v_correction_id from public.inventory_corrections
       where organization_id = p_organization_id and client_request_id = v_row_key;
      if not found then
        raise exception 'client_request_id % conflicted but no matching correction was found on retry', v_row_key;
      end if;
    end;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_app_user_id, 'INVENTORY_CORRECTION_RECORDED', 'inventory_item', v_pl.inventory_item_id,
      jsonb_build_object('postingLineId', v_pl.id, 'quantity', v_pl.posted_base_quantity),
      jsonb_build_object('quantity', v_new_quantity, 'reason', v_reason, 'locationId', v_pl.location_id));

    v_result_ids := array_append(v_result_ids, v_correction_id);
  end loop;

  return query select v_result_ids, false;
end;
$$;
