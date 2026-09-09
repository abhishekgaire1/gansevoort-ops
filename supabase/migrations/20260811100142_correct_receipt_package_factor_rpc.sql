-- Safe editing of confirmed items with inventory-impact protection (Part 7).
--
-- The flagship "current inventory will change" workflow (spec section 7):
-- a manager corrects one or more ALREADY-POSTED receipt lines that used a
-- vendor package factor later discovered to be wrong. Never rewrites the
-- original receipt/posting/movement rows (all hard append-only, trigger-
-- enforced) -- only ever inserts new rows describing the delta. Each
-- selected posting line becomes its OWN correction event with its OWN
-- inventory_movements row (one movement + one movement_line each,
-- mirroring record_inventory_waste's "one event, one movement" idiom --
-- not complete_cycle_count's per-location grouping, which is specific to
-- representing one physical count session as a single adjustment).
--
-- ============================================================
-- 1. Read-only: which posted receipt lines used a given package version.
-- ============================================================
-- Exactly the list the "Correct inventory from previous receipts" picker
-- needs: document/date/location/original received quantity/original
-- normalized quantity (spec section 7's own example table).
create function public.list_receipts_using_vendor_package_version(
  p_organization_id uuid,
  p_vendor_item_purchase_unit_id uuid
) returns table (
  out_posting_line_id uuid,
  out_purchase_document_id uuid,
  out_document_number text,
  out_document_date date,
  out_location_id uuid,
  out_location_name text,
  out_original_received_package_quantity numeric,
  out_original_package_unit text,
  out_original_normalized_base_quantity numeric,
  out_base_unit_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pl.id, r.purchase_document_id, pd.document_number, pd.document_date,
    pl.location_id, loc.name,
    rl.actual_received_package_quantity, rl.actual_received_package_unit,
    pl.posted_base_quantity, u.code
  from public.purchase_document_inventory_posting_lines pl
  join public.receipt_lines rl on rl.id = pl.receipt_line_id
  join public.receipts r on r.id = rl.receipt_id
  join public.purchase_document_line_classifications c
    on c.organization_id = pl.organization_id
   and c.purchase_document_id = r.purchase_document_id
   and c.line_key = rl.matched_line_key
  join public.purchase_documents pd on pd.id = r.purchase_document_id
  join public.locations loc on loc.id = pl.location_id
  join public.units u on u.id = pl.base_unit_id
  where pl.organization_id = p_organization_id
    and c.vendor_item_purchase_unit_id = p_vendor_item_purchase_unit_id
  order by pd.document_date desc, pd.id desc;
$$;

revoke all on function public.list_receipts_using_vendor_package_version(uuid, uuid) from public;
grant execute on function public.list_receipts_using_vendor_package_version(uuid, uuid) to service_role;

-- ============================================================
-- 2. Write: apply the correction to the selected posting lines.
-- ============================================================
-- Idempotency uses the SAME "batchKey:rowId" composite pattern already
-- established in this schema (receipts.idempotency_key,
-- 20260811100040/session-correction usage) -- one inventory_corrections
-- row's own client_request_id is p_client_request_id || ':' ||
-- posting_line_id, so a retry of the exact same batch converges row-by-
-- row rather than needing one giant all-or-nothing key across an
-- arbitrary array. A batch that mixes previously-applied and new
-- posting_line_ids under the SAME p_client_request_id is treated as a
-- payload mismatch (GA029) -- a genuine retry always resubmits the exact
-- same set.
create function public.correct_receipt_package_factor(
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

      insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id)
      values (v_movement_id, v_pl.inventory_item_id, abs(v_delta), v_new_vpu.purchase_unit_id)
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
      -- Genuinely concurrent identical retry that slipped past the
      -- up-front idempotency scan (raced between that scan and this
      -- insert) -- converge onto whatever the winner committed, same as
      -- every other idempotent RPC in this schema.
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

revoke all on function public.correct_receipt_package_factor(uuid, uuid, uuid[], uuid, text, uuid) from public;
grant execute on function public.correct_receipt_package_factor(uuid, uuid, uuid[], uuid, text, uuid) to service_role;
