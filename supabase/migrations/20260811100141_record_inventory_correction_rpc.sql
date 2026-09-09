-- Safe editing of confirmed items with inventory-impact protection (Part 6).
--
-- record_inventory_correction is the generic "Adjust Inventory" action
-- (spec section 10): a manager corrects current on-hand quantity at one
-- location, either by entering a fresh COUNTED quantity or a direct
-- DELTA. Mirrors record_inventory_waste's idempotency contract closely
-- (20260811100085) -- organization is resolved from the acting app_user,
-- never trusted from a client parameter, matching every other inventory-
-- ledger RPC (waste/withdrawal) in this schema -- and, like waste, always
-- operates in the item's own base unit, never a client-supplied
-- packaging unit ("Do not introduce CASE/BOX conversion here" applies
-- identically to a correction as it does to waste).
--
-- Combines that idempotency shape with complete_cycle_count's locking
-- discipline (20260811100081): advisory-lock (organization, item,
-- location) BEFORE reading the authoritative current balance, so two
-- concurrent corrections on the same item/location can never both
-- compute their delta against the same stale balance.
--
-- Zero-variance mirrors cycle count's own rule exactly: no
-- inventory_movements row is ever created for a quantity that didn't
-- change (inventory_movement_lines_entered_quantity_check requires
-- entered_quantity > 0 in the first place) -- but an inventory_
-- corrections row is still written, so a "checked, no change needed"
-- adjustment still appears in the item's history.
create function public.record_inventory_correction(
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_mode text,
  p_counted_quantity numeric,
  p_delta_quantity numeric,
  p_reason text,
  p_client_request_id uuid
) returns table (
  out_correction_id uuid,
  out_movement_id uuid,
  out_previous_balance numeric,
  out_new_balance numeric,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_base_unit_id uuid;
  v_location_timezone text;
  v_business_date date;
  v_reason text;
  v_current_balance numeric;
  v_delta numeric;
  v_movement_id uuid;
  v_line_id uuid;
  v_correction_id uuid;
  v_existing record;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;
  if p_mode not in ('COUNTED', 'DELTA') then
    raise exception 'mode must be COUNTED or DELTA'
      using errcode = 'GA033';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_app_user_id and au.is_active;
  if not found then
    raise exception 'app_user_id % is not an active app user', p_app_user_id;
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'a reason is required for an inventory correction'
      using errcode = 'GA033';
  end if;

  if p_mode = 'COUNTED' then
    if p_counted_quantity is null or p_counted_quantity < 0 or p_counted_quantity = 'NaN'::numeric or p_delta_quantity is not null then
      raise exception 'COUNTED mode requires a non-negative counted_quantity and no delta_quantity'
        using errcode = 'GA079';
    end if;
  else
    if p_delta_quantity is null or p_delta_quantity = 'NaN'::numeric or p_counted_quantity is not null then
      raise exception 'DELTA mode requires a delta_quantity and no counted_quantity'
        using errcode = 'GA079';
    end if;
  end if;

  -- Idempotency check FIRST, before any state-dependent validation --
  -- identical shape to record_inventory_waste.
  select ic.id as existing_id, ic.movement_id as existing_movement_id,
         ic.inventory_item_id as existing_item_id, ic.location_id as existing_location_id,
         ic.previous_quantity as existing_previous_quantity, ic.new_quantity as existing_new_quantity,
         ic.reason as existing_reason, ic.performed_by_app_user_id as existing_actor
    into v_existing
    from public.inventory_corrections ic
   where ic.organization_id = v_org_id
     and ic.client_request_id = p_client_request_id::text;

  if found then
    if v_existing.existing_item_id is distinct from p_inventory_item_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_actor is distinct from p_app_user_id
       or v_existing.existing_reason is distinct from v_reason
    then
      raise exception 'client_request_id % was already used with a different correction payload', p_client_request_id
        using errcode = 'GA029';
    end if;
    return query select v_existing.existing_id, v_existing.existing_movement_id,
                        v_existing.existing_previous_quantity, v_existing.existing_new_quantity, true;
    return;
  end if;

  select timezone into v_location_timezone
    from public.locations
   where id = p_location_id and organization_id = v_org_id and is_active and is_storage_eligible;
  if not found then
    raise exception 'location_id % is not an active, storage-eligible location in organization %', p_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = v_org_id
     and status = 'active' and disposition = 'INVENTORY' and approval_status = 'CONFIRMED';
  if not found then
    raise exception 'inventory_item_id % is not a confirmed, active INVENTORY item in organization %', p_inventory_item_id, v_org_id
      using errcode = 'GA051';
  end if;

  v_business_date := (now() at time zone v_location_timezone)::date;

  -- Same locking discipline as waste/withdrawal/cycle-count: serialize on
  -- (organization, item, location) BEFORE reading the authoritative
  -- pre-correction balance.
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_location_id));
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_location_id);

  v_delta := case when p_mode = 'COUNTED' then p_counted_quantity - v_current_balance else p_delta_quantity end;

  if v_delta = 0 then
    begin
      insert into public.inventory_corrections (
        organization_id, correction_type, inventory_item_id, location_id,
        movement_id, movement_line_id, previous_quantity, new_quantity, quantity_delta,
        reason, performed_by_app_user_id, client_request_id
      ) values (
        v_org_id, 'MANUAL_ADJUSTMENT', p_inventory_item_id, p_location_id,
        null, null, v_current_balance, v_current_balance, 0,
        v_reason, p_app_user_id, p_client_request_id::text
      ) returning id into v_correction_id;
    exception when unique_violation then
      -- Genuinely concurrent identical zero-variance retry -- there is no
      -- movements-table insert on this path to race on instead, so this
      -- table's own (organization_id, client_request_id) unique
      -- constraint is what catches it.
      select ic.id as existing_id, ic.movement_id as existing_movement_id,
             ic.inventory_item_id as existing_item_id, ic.location_id as existing_location_id,
             ic.previous_quantity as existing_previous_quantity, ic.new_quantity as existing_new_quantity,
             ic.reason as existing_reason, ic.performed_by_app_user_id as existing_actor
        into v_existing
        from public.inventory_corrections ic
       where ic.organization_id = v_org_id
         and ic.client_request_id = p_client_request_id::text;

      if not found then
        raise exception 'client_request_id % conflicted but no matching correction was found on retry', p_client_request_id;
      end if;
      if v_existing.existing_item_id is distinct from p_inventory_item_id
         or v_existing.existing_location_id is distinct from p_location_id
         or v_existing.existing_actor is distinct from p_app_user_id
         or v_existing.existing_reason is distinct from v_reason
      then
        raise exception 'client_request_id % was already used with a different correction payload', p_client_request_id
          using errcode = 'GA029';
      end if;
      return query select v_existing.existing_id, v_existing.existing_movement_id,
                          v_existing.existing_previous_quantity, v_existing.existing_new_quantity, true;
      return;
    end;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (v_org_id, p_app_user_id, 'INVENTORY_CORRECTION_RECORDED', 'inventory_item', p_inventory_item_id,
      jsonb_build_object('balance', v_current_balance),
      jsonb_build_object('balance', v_current_balance, 'reason', v_reason, 'locationId', p_location_id));

    return query select v_correction_id, null::uuid, v_current_balance, v_current_balance, false;
    return;
  end if;

  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id, location_attribution
    ) values (
      v_org_id, p_location_id, null,
      case when v_delta > 0 then 'INVENTORY_CORRECTION_IN' else 'INVENTORY_CORRECTION_OUT' end,
      p_app_user_id, v_business_date, v_reason, p_client_request_id, 'EXACT'
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    select ic.id as existing_id, ic.movement_id as existing_movement_id,
           ic.inventory_item_id as existing_item_id, ic.location_id as existing_location_id,
           ic.previous_quantity as existing_previous_quantity, ic.new_quantity as existing_new_quantity,
           ic.reason as existing_reason, ic.performed_by_app_user_id as existing_actor
      into v_existing
      from public.inventory_corrections ic
     where ic.organization_id = v_org_id
       and ic.client_request_id = p_client_request_id::text;

    if not found then
      raise exception 'client_request_id % conflicted but no matching correction was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_item_id is distinct from p_inventory_item_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_actor is distinct from p_app_user_id
       or v_existing.existing_reason is distinct from v_reason
    then
      raise exception 'client_request_id % was already used with a different correction payload', p_client_request_id
        using errcode = 'GA029';
    end if;

    return query select v_existing.existing_id, v_existing.existing_movement_id,
                        v_existing.existing_previous_quantity, v_existing.existing_new_quantity, true;
    return;
  end;

  insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id)
  values (v_movement_id, p_inventory_item_id, abs(v_delta), v_base_unit_id)
  returning id into v_line_id;

  insert into public.inventory_corrections (
    organization_id, correction_type, inventory_item_id, location_id,
    movement_id, movement_line_id, previous_quantity, new_quantity, quantity_delta,
    reason, performed_by_app_user_id, client_request_id
  ) values (
    v_org_id, 'MANUAL_ADJUSTMENT', p_inventory_item_id, p_location_id,
    v_movement_id, v_line_id, v_current_balance, v_current_balance + v_delta, v_delta,
    v_reason, p_app_user_id, p_client_request_id::text
  ) returning id into v_correction_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (v_org_id, p_app_user_id, 'INVENTORY_CORRECTION_RECORDED', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('balance', v_current_balance),
    jsonb_build_object('balance', v_current_balance + v_delta, 'reason', v_reason, 'locationId', p_location_id));

  return query select v_correction_id, v_movement_id, v_current_balance, v_current_balance + v_delta, false;
end;
$$;

revoke all on function public.record_inventory_correction(uuid, uuid, uuid, text, numeric, numeric, text, uuid) from public;
grant execute on function public.record_inventory_correction(uuid, uuid, uuid, text, numeric, numeric, text, uuid) to service_role;
