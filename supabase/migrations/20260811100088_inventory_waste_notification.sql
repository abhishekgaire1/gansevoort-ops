-- Inventory Waste: notify every manager/admin in the organization when a
-- waste event is actually recorded (standalone OR cycle-count-sourced,
-- since record_cycle_count_line_waste calls this same function
-- internally) -- same broadcast pattern already established for Cycle
-- Count completion (20260811100084_cycle_count_completion_notification.
-- sql): reuses the existing, deliberately generic user_notifications
-- table, excludes the recording manager (they already know), and only
-- fires on a genuine first-time creation, never on an idempotent replay.
--
-- Same 9-argument signature as 20260811100085/100087 (unchanged), so
-- CREATE OR REPLACE is a true replace, not a new overload. A NEW
-- migration rather than editing 20260811100085 in place, since that
-- migration's applied state on DEV cannot be confirmed from this
-- environment -- never edit a migration whose applied status is
-- uncertain.
create or replace function public.record_inventory_waste(
  p_recorded_by_app_user_id uuid,
  p_location_id uuid,
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_reason_code text,
  p_note text,
  p_client_request_id uuid,
  p_cycle_count_id uuid default null,
  p_cycle_count_line_id uuid default null
) returns table (
  out_waste_event_id uuid,
  out_movement_id uuid,
  out_movement_line_id uuid,
  out_quantity numeric,
  out_unit_code text,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_base_unit_id uuid;
  v_unit_code text;
  v_unit_type text;
  v_item_name text;
  v_location_timezone text;
  v_location_name text;
  v_business_date date;
  v_note text;
  v_current_balance numeric;
  v_movement_id uuid;
  v_line_id uuid;
  v_waste_event_id uuid;
  v_existing record;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_recorded_by_app_user_id and au.is_active;

  if not found then
    raise exception 'recorded_by_app_user_id % is not an active app user', p_recorded_by_app_user_id;
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- Idempotency check FIRST (before any validation that could differ
  -- between the original attempt and a retry due to intervening state
  -- change) -- a retry must match the ORIGINAL request on every
  -- business-significant field or fail closed, exactly like
  -- record_inventory_withdrawal.
  select we.id as existing_waste_event_id, we.inventory_movement_id as existing_movement_id,
         we.location_id as existing_location_id, we.inventory_item_id as existing_inventory_item_id,
         we.quantity as existing_quantity, we.reason_code as existing_reason_code,
         we.note as existing_note, we.recorded_by_app_user_id as existing_recorded_by_app_user_id,
         we.unit_code as existing_unit_code, we.cycle_count_id as existing_cycle_count_id,
         we.cycle_count_line_id as existing_cycle_count_line_id,
         ml.id as existing_movement_line_id
    into v_existing
    from public.inventory_waste_events we
    join public.inventory_movement_lines ml on ml.movement_id = we.inventory_movement_id
   where we.organization_id = v_org_id
     and we.client_request_id = p_client_request_id;

  if found then
    if v_existing.existing_recorded_by_app_user_id is distinct from p_recorded_by_app_user_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_quantity is distinct from p_quantity
       or v_existing.existing_reason_code is distinct from p_reason_code
       or v_existing.existing_note is distinct from v_note
       or v_existing.existing_cycle_count_id is distinct from p_cycle_count_id
       or v_existing.existing_cycle_count_line_id is distinct from p_cycle_count_line_id
    then
      raise exception 'client_request_id % was already used with a different waste payload', p_client_request_id
        using errcode = 'GA029';
    end if;

    return query select
      v_existing.existing_waste_event_id, v_existing.existing_movement_id, v_existing.existing_movement_line_id,
      v_existing.existing_quantity, v_existing.existing_unit_code, true;
    return;
  end if;

  -- Reason + note validation (Part 14) -- server-enforced, never
  -- frontend-only. Blank-after-trim is never accepted for OTHER. An
  -- unrecognized reason_code is a defensive/theoretical guard only (the
  -- UI only ever sends one of the six controlled values) so it is not
  -- part of the GA0xx taxonomy the UI parses -- WASTE_NOTE_REQUIRED
  -- (GA028) is reserved specifically for the OTHER-requires-note case.
  if p_reason_code not in ('EXPIRED', 'SPOILED', 'DAMAGED', 'CONTAMINATED', 'STORAGE_ISSUE', 'OTHER') then
    raise exception 'reason_code % is not a recognized waste reason', p_reason_code;
  end if;
  if p_reason_code = 'OTHER' and v_note is null then
    raise exception 'a note is required when waste reason is OTHER'
      using errcode = 'GA028';
  end if;

  -- Quantity validation (Part 8/10) -- must be positive; COUNT-category
  -- base units must be a whole number (checked below once the base unit
  -- is resolved).
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'waste quantity must be greater than zero'
      using errcode = 'GA026';
  end if;

  -- Location: active AND storage-eligible only (Part 6) -- a
  -- business/site/station location is never a valid waste location, same
  -- rule record_inventory_withdrawal already enforces for its source
  -- location.
  select timezone, name into v_location_timezone, v_location_name
    from public.locations
   where id = p_location_id and organization_id = v_org_id and is_active and is_storage_eligible;

  if not found then
    raise exception 'location_id % is not an active, storage-eligible location in organization %', p_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  -- Item: active only, same organization.
  select i.base_unit_id, i.name, u.code, u.unit_type
    into v_base_unit_id, v_item_name, v_unit_code, v_unit_type
    from public.inventory_items i
    join public.units u on u.id = i.base_unit_id
   where i.id = p_inventory_item_id and i.organization_id = v_org_id and i.status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id
      using errcode = 'GA027';
  end if;

  if v_unit_type = 'COUNT' and p_quantity <> trunc(p_quantity) then
    raise exception 'waste quantity % must be a whole number for a COUNT-unit item', p_quantity
      using errcode = 'GA026';
  end if;

  v_business_date := (now() at time zone v_location_timezone)::date;

  -- Serialize on (organization, item, location) BEFORE reading the
  -- authoritative pre-waste balance -- identical locking discipline to
  -- record_inventory_withdrawal (Part 10).
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_location_id));
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_location_id);

  if p_quantity > v_current_balance then
    raise exception 'waste quantity % exceeds available inventory % at location %', p_quantity, v_current_balance, p_location_id
      using errcode = 'GA022',
            detail = jsonb_build_object('availableQuantity', v_current_balance, 'requestedQuantity', p_quantity)::text;
  end if;

  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id, location_attribution, cycle_count_id
    ) values (
      v_org_id, p_location_id, null, 'WASTE',
      p_recorded_by_app_user_id, v_business_date, v_note, p_client_request_id, 'EXACT', p_cycle_count_id
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    -- Two genuinely concurrent identical retries -- same race-resolution
    -- shape as record_inventory_withdrawal: the loser re-reads whatever
    -- the winner committed and returns that instead of erroring.
    select we.id as existing_waste_event_id, we.inventory_movement_id as existing_movement_id,
           we.location_id as existing_location_id, we.inventory_item_id as existing_inventory_item_id,
           we.quantity as existing_quantity, we.reason_code as existing_reason_code,
           we.note as existing_note, we.recorded_by_app_user_id as existing_recorded_by_app_user_id,
           we.unit_code as existing_unit_code, we.cycle_count_id as existing_cycle_count_id,
           we.cycle_count_line_id as existing_cycle_count_line_id,
           ml.id as existing_movement_line_id
      into v_existing
      from public.inventory_waste_events we
      join public.inventory_movement_lines ml on ml.movement_id = we.inventory_movement_id
     where we.organization_id = v_org_id
       and we.client_request_id = p_client_request_id;

    if not found then
      raise exception 'client_request_id % conflicted but no matching waste event was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_recorded_by_app_user_id is distinct from p_recorded_by_app_user_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_quantity is distinct from p_quantity
       or v_existing.existing_reason_code is distinct from p_reason_code
       or v_existing.existing_note is distinct from v_note
       or v_existing.existing_cycle_count_id is distinct from p_cycle_count_id
       or v_existing.existing_cycle_count_line_id is distinct from p_cycle_count_line_id
    then
      raise exception 'client_request_id % was already used with a different waste payload', p_client_request_id
        using errcode = 'GA029';
    end if;

    return query select
      v_existing.existing_waste_event_id, v_existing.existing_movement_id, v_existing.existing_movement_line_id,
      v_existing.existing_quantity, v_existing.existing_unit_code, true;
    return;
  end;

  insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id, cycle_count_line_id)
  values (v_movement_id, p_inventory_item_id, p_quantity, v_base_unit_id, p_cycle_count_line_id)
  returning id into v_line_id;

  insert into public.inventory_waste_events (
    organization_id, location_id, inventory_item_id, quantity, unit_code, reason_code, note,
    recorded_by_app_user_id, client_request_id, inventory_movement_id, cycle_count_id, cycle_count_line_id
  ) values (
    v_org_id, p_location_id, p_inventory_item_id, p_quantity, v_unit_code, p_reason_code, v_note,
    p_recorded_by_app_user_id, p_client_request_id, v_movement_id, p_cycle_count_id, p_cycle_count_line_id
  ) returning id into v_waste_event_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    v_org_id, p_recorded_by_app_user_id, 'INVENTORY_WASTE_RECORDED', 'inventory_waste_event', v_waste_event_id,
    jsonb_build_object(
      'wasteEventId', v_waste_event_id,
      'itemId', p_inventory_item_id,
      'locationId', p_location_id,
      'quantity', p_quantity,
      'unit', v_unit_code,
      'reason', p_reason_code,
      'cycleCountId', p_cycle_count_id
    )
  );

  -- Notify every OTHER active manager/admin in the org (20260811100088).
  -- Same role definition requireManagerOrAdmin uses client-side and the
  -- SAME broadcast shape as complete_cycle_count's own notification
  -- (20260811100084) -- every recipient is guaranteed to have a
  -- notification bell that can show it, and the recording manager is
  -- excluded since they already know. Fires only here, on a genuine
  -- first-time creation -- never on either replay branch above, so a
  -- retried/duplicate submission never sends a second notification.
  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  )
  select v_org_id, recipient.app_user_id, 'INVENTORY_WASTE_RECORDED', 'inventory_waste_event', v_waste_event_id,
    format('Inventory waste recorded: %s', v_item_name),
    format(
      '%s %s wasted at %s (%s).',
      p_quantity, v_unit_code, v_location_name,
      case p_reason_code
        when 'EXPIRED' then 'Expired'
        when 'SPOILED' then 'Spoiled'
        when 'DAMAGED' then 'Damaged'
        when 'CONTAMINATED' then 'Contaminated'
        when 'STORAGE_ISSUE' then 'Storage Issue'
        else 'Other'
      end
    ),
    jsonb_build_object(
      'wasteEventId', v_waste_event_id,
      'itemId', p_inventory_item_id,
      'locationId', p_location_id,
      'quantity', p_quantity,
      'unit', v_unit_code,
      'reason', p_reason_code,
      'recordedByAppUserId', p_recorded_by_app_user_id,
      'cycleCountId', p_cycle_count_id
    )
  from (
    select distinct au.id as app_user_id
      from public.app_users au
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id
     where au.organization_id = v_org_id
       and au.is_active
       and r.name in ('manager', 'admin')
       and au.id <> p_recorded_by_app_user_id
  ) recipient;

  return query select v_waste_event_id, v_movement_id, v_line_id, p_quantity, v_unit_code, false;
end;
$$;

revoke all on function public.record_inventory_waste(uuid, uuid, uuid, numeric, text, text, uuid, uuid, uuid) from public;
grant execute on function public.record_inventory_waste(uuid, uuid, uuid, numeric, text, text, uuid, uuid, uuid) to service_role;
