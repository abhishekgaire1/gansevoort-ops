-- Milestone 2A.5 fix-forward -- 20260811100073 already applied, so this
-- is a targeted create-or-replace (same signature, no drop needed): the
-- GA022 insufficient-inventory rejection gains a structured jsonb DETAIL
-- (availableQuantity/requestedQuantity), matching the exact convention
-- 20260811100064's GA017 posting-blocker error already established, so
-- the kiosk never has to parse the human-readable message text.

create or replace function public.record_inventory_withdrawal(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_inventory_item_id uuid,
  p_source_location_id uuid,
  p_entered_quantity numeric,
  p_entered_unit_id uuid,
  p_measured_base_quantity numeric default null,
  p_notes text default null,
  p_client_request_id uuid default null
)
returns table (
  movement_id uuid,
  movement_line_id uuid,
  normalized_base_quantity numeric,
  base_unit_id uuid,
  exception_id uuid,
  exception_raised boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
  v_employee_status text;
  v_default_station_id uuid;
  v_auto_resolve_station boolean;
  v_can_change_station boolean;
  v_station_location_id uuid;
  v_timezone text;
  v_business_date date;
  v_movement_id uuid;
  v_line_id uuid;
  v_normalized numeric;
  v_base_unit_id uuid;
  v_rule_id uuid;
  v_threshold numeric;
  v_exception_id uuid;
  v_existing record;
  v_current_balance numeric;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  -- 1. Resolve and validate the acting employee. Never trust organization_id
  -- from the caller -- it is derived here from the app_user.
  select au.organization_id, au.employee_id
    into v_org_id, v_employee_id
    from public.app_users au
   where au.id = p_performed_by_app_user_id
     and au.is_active;

  if not found then
    raise exception 'performed_by_app_user_id % is not an active app user', p_performed_by_app_user_id;
  end if;

  -- 2. Idempotency check. A retry must match the ORIGINAL request on every
  -- security/business-significant field -- actor, station, item, SOURCE
  -- LOCATION, entered unit, entered quantity, and measured_base_quantity
  -- -- or the call fails closed instead of silently replaying a different
  -- withdrawal (Milestone 2A.5: source location joins this comparison).
  select im.id as existing_movement_id,
         im.performed_by_app_user_id as existing_performed_by_app_user_id,
         im.station_id as existing_station_id,
         im.location_id as existing_location_id,
         ml.id as existing_movement_line_id,
         ml.inventory_item_id as existing_inventory_item_id,
         ml.entered_quantity as existing_entered_quantity,
         ml.entered_unit_id as existing_entered_unit_id,
         ml.measured_base_quantity as existing_measured_base_quantity,
         ml.normalized_base_quantity as existing_normalized_base_quantity,
         ml.base_unit_id as existing_base_unit_id,
         ex.id as existing_exception_id
    into v_existing
    from public.inventory_movements im
    join public.inventory_movement_lines ml on ml.movement_id = im.id
    left join public.exceptions ex on ex.source_movement_line_id = ml.id
   where im.organization_id = v_org_id
     and im.client_request_id = p_client_request_id;

  if found then
    if v_existing.existing_performed_by_app_user_id is distinct from p_performed_by_app_user_id
       or v_existing.existing_station_id is distinct from p_station_id
       or v_existing.existing_location_id is distinct from p_source_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_entered_unit_id is distinct from p_entered_unit_id
       or v_existing.existing_entered_quantity is distinct from p_entered_quantity
       or v_existing.existing_measured_base_quantity is distinct from p_measured_base_quantity
    then
      raise exception 'client_request_id % was already used with a different withdrawal payload', p_client_request_id;
    end if;

    return query select
      v_existing.existing_movement_id,
      v_existing.existing_movement_line_id,
      v_existing.existing_normalized_base_quantity,
      v_existing.existing_base_unit_id,
      v_existing.existing_exception_id,
      v_existing.existing_exception_id is not null,
      true;
    return;
  end if;

  select e.status, e.default_station_id, e.auto_resolve_station, e.can_change_station
    into v_employee_status, v_default_station_id, v_auto_resolve_station, v_can_change_station
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization: an employee locked to their default station
  -- may not submit a withdrawal for any other station, regardless of what
  -- the caller sent.
  if v_auto_resolve_station and not v_can_change_station then
    if p_station_id is distinct from v_default_station_id then
      raise exception 'employee % is restricted to their default station and may not use station %',
        v_employee_id, p_station_id;
    end if;
  end if;

  -- 4. Active-record validation. The station still resolves the
  -- OPERATIONAL business_date/timezone (a site property) -- it no longer
  -- determines the movement's location, which is the caller-chosen
  -- SOURCE STORAGE location instead (2A.5).
  select s.location_id
    into v_station_location_id
    from public.stations s
   where s.id = p_station_id
     and s.organization_id = v_org_id
     and s.is_active;

  if not found then
    raise exception 'station_id % is not an active station in organization %', p_station_id, v_org_id;
  end if;

  select l.timezone
    into v_timezone
    from public.locations l
   where l.id = v_station_location_id
     and l.is_active;

  if not found then
    raise exception 'location for station_id % is not active', p_station_id;
  end if;

  if not exists (
    select 1 from public.locations
     where id = p_source_location_id and organization_id = v_org_id and is_active and is_storage_eligible
  ) then
    raise exception 'source_location_id % is not an active storage-eligible location in organization %', p_source_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  perform 1
    from public.inventory_items i
   where i.id = p_inventory_item_id
     and i.organization_id = v_org_id
     and i.status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id;
  end if;

  v_business_date := (now() at time zone v_timezone)::date;

  -- 5. Serialize on (organization, item, SOURCE LOCATION) before reading
  -- the authoritative current balance -- no client-side availability
  -- check is ever trusted, and no mutable balance row exists to lock
  -- instead. Transaction-scoped: released automatically at commit/
  -- rollback.
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_source_location_id));

  -- The measurement trigger below computes normalized_base_quantity
  -- authoritatively; entered_quantity in base units is already what a
  -- non-measured ISSUE_TO_STATION line normalizes to 1:1 (base-unit-only,
  -- enforced by enforce_movement_line_measurement). For a
  -- requires-measurement item, p_measured_base_quantity IS the
  -- normalized quantity -- use it directly for the availability check so
  -- a measured withdrawal is validated against its own actual measured
  -- amount, never its nominal entered count.
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_source_location_id);

  if coalesce(p_measured_base_quantity, p_entered_quantity) > v_current_balance then
    -- Structured detail (never parsed from prose) so the kiosk can render
    -- the exact required message ("Only N UNIT are currently available in
    -- LOCATION.") without regexing the human-readable text.
    raise exception 'only % is currently available for inventory_item % at location % (requested %)',
      v_current_balance, p_inventory_item_id, p_source_location_id, coalesce(p_measured_base_quantity, p_entered_quantity)
      using errcode = 'GA022',
            detail = jsonb_build_object(
              'availableQuantity', v_current_balance,
              'requestedQuantity', coalesce(p_measured_base_quantity, p_entered_quantity)
            )::text;
  end if;

  -- 6. Movement header. location_id is now the chosen SOURCE STORAGE
  -- location (not the station's site); location_attribution is EXACT --
  -- this is a genuinely chosen, not estimated, source.
  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id, location_attribution
    ) values (
      v_org_id, p_source_location_id, p_station_id, 'ISSUE_TO_STATION',
      p_performed_by_app_user_id, v_business_date, p_notes, p_client_request_id, 'EXACT'
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    -- Two genuinely concurrent identical retries: both passed the
    -- idempotency check above (neither had committed yet), only one
    -- insert wins the partial unique index; the loser re-reads the
    -- winner's now-committed row and returns the identical result rather
    -- than erroring.
    select im.id as existing_movement_id,
           im.performed_by_app_user_id as existing_performed_by_app_user_id,
           im.station_id as existing_station_id,
           im.location_id as existing_location_id,
           ml.id as existing_movement_line_id,
           ml.inventory_item_id as existing_inventory_item_id,
           ml.entered_quantity as existing_entered_quantity,
           ml.entered_unit_id as existing_entered_unit_id,
           ml.measured_base_quantity as existing_measured_base_quantity,
           ml.normalized_base_quantity as existing_normalized_base_quantity,
           ml.base_unit_id as existing_base_unit_id,
           ex.id as existing_exception_id
      into v_existing
      from public.inventory_movements im
      join public.inventory_movement_lines ml on ml.movement_id = im.id
      left join public.exceptions ex on ex.source_movement_line_id = ml.id
     where im.organization_id = v_org_id
       and im.client_request_id = p_client_request_id;

    if not found then
      raise exception 'client_request_id % conflicted but no matching movement was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_performed_by_app_user_id is distinct from p_performed_by_app_user_id
       or v_existing.existing_station_id is distinct from p_station_id
       or v_existing.existing_location_id is distinct from p_source_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_entered_unit_id is distinct from p_entered_unit_id
       or v_existing.existing_entered_quantity is distinct from p_entered_quantity
       or v_existing.existing_measured_base_quantity is distinct from p_measured_base_quantity
    then
      raise exception 'client_request_id % was already used with a different withdrawal payload', p_client_request_id;
    end if;

    return query select
      v_existing.existing_movement_id,
      v_existing.existing_movement_line_id,
      v_existing.existing_normalized_base_quantity,
      v_existing.existing_base_unit_id,
      v_existing.existing_exception_id,
      v_existing.existing_exception_id is not null,
      true;
    return;
  end;

  -- 7. Movement line. enforce_movement_line_measurement() validates the
  -- item/unit pair and computes organization_id, base_unit_id, and
  -- normalized_base_quantity.
  insert into public.inventory_movement_lines as ml (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  ) values (
    v_movement_id, p_inventory_item_id, p_entered_quantity, p_entered_unit_id, p_measured_base_quantity
  ) returning ml.id, ml.normalized_base_quantity, ml.base_unit_id
    into v_line_id, v_normalized, v_base_unit_id;

  -- 8. HIGH_WITHDRAWAL check -- an operational anomaly signal, evaluated
  -- independently of and never blocking on availability (2A.5: keep
  -- these two concepts separate, per spec).
  select cr.id, cr.threshold_quantity
    into v_rule_id, v_threshold
    from public.control_rules cr
   where cr.organization_id = v_org_id
     and cr.inventory_item_id = p_inventory_item_id
     and cr.rule_type = 'HIGH_WITHDRAWAL'
     and cr.is_active
     and cr.station_id = p_station_id;

  if not found then
    select cr.id, cr.threshold_quantity
      into v_rule_id, v_threshold
      from public.control_rules cr
     where cr.organization_id = v_org_id
       and cr.inventory_item_id = p_inventory_item_id
       and cr.rule_type = 'HIGH_WITHDRAWAL'
       and cr.is_active
       and cr.station_id is null;
  end if;

  if found and v_normalized > v_threshold then
    insert into public.exceptions as ex (
      organization_id, exception_type, control_rule_id,
      source_movement_id, source_movement_line_id, inventory_item_id, station_id,
      observed_quantity, threshold_quantity_at_detection, base_unit_id
    ) values (
      v_org_id, 'HIGH_WITHDRAWAL', v_rule_id,
      v_movement_id, v_line_id, p_inventory_item_id, p_station_id,
      v_normalized, v_threshold, v_base_unit_id
    ) returning ex.id into v_exception_id;
  end if;

  -- 9. Audit event.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    v_org_id, p_performed_by_app_user_id, 'INVENTORY_WITHDRAWAL_RECORDED',
    'inventory_movement', v_movement_id,
    jsonb_build_object(
      'movement_line_id', v_line_id, 'inventory_item_id', p_inventory_item_id,
      'station_id', p_station_id, 'source_location_id', p_source_location_id,
      'entered_quantity', p_entered_quantity,
      'entered_unit_id', p_entered_unit_id, 'measured_base_quantity', p_measured_base_quantity,
      'normalized_base_quantity', v_normalized, 'base_unit_id', v_base_unit_id,
      'exception_id', v_exception_id
    )
  );

  return query select v_movement_id, v_line_id, v_normalized, v_base_unit_id, v_exception_id, v_exception_id is not null, false;
end;
$$;

revoke all on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) from public;
grant execute on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) to service_role;
