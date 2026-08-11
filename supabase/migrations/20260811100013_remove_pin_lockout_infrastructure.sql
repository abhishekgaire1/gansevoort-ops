-- Remove V1 per-employee PIN lockout infrastructure.
--
-- Product decision (V1): keep PIN-only kiosk identification -- no
-- employee-name/code selection step before PIN entry. pin_lookup_hash is
-- HMAC-SHA256 of the literal submitted PIN, so a matching app_users row can
-- only ever be found when the submitted PIN already equals the one the
-- account was set up with (mod a cryptographically negligible HMAC
-- collision). An incorrect PIN can therefore never be attributed to a
-- specific employee -- only "no match" in general -- which makes a
-- per-employee failed-attempt counter/lockout unreachable by its intended
-- trigger condition (a legitimate employee mistyping their own PIN) and
-- dead code in normal operation. Brute-forcing the PIN space is still
-- blunted by the source-based rate limiter in pin_verify_rate_limits
-- (20260811100009), which this migration does not touch.
--
-- register_pin_verification_failure() (20260811100011) is dropped outright:
-- nothing calls it once verifyPinCore no longer has an "identified wrong
-- PIN" branch to call it from.
drop function public.register_pin_verification_failure(uuid);

-- record_inventory_withdrawal (20260811100010) gated the acting app_user on
-- app_users.locked_until as part of its authorization check; that column is
-- being dropped below, so the function must be replaced first to stop
-- referencing it before the column disappears. Everything else in the body
-- is unchanged from 20260811100010 -- only the locked_until clause and its
-- error message are removed.
create or replace function public.record_inventory_withdrawal(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_inventory_item_id uuid,
  p_entered_quantity numeric,
  p_entered_unit_id uuid,
  p_measured_base_quantity numeric default null,
  p_notes text default null
)
returns table (
  movement_id uuid,
  movement_line_id uuid,
  normalized_base_quantity numeric,
  base_unit_id uuid,
  exception_id uuid,
  exception_raised boolean
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
  v_location_id uuid;
  v_timezone text;
  v_business_date date;
  v_movement_id uuid;
  v_line_id uuid;
  v_normalized numeric;
  v_base_unit_id uuid;
  v_rule_id uuid;
  v_threshold numeric;
  v_exception_id uuid;
begin
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

  select e.status, e.default_station_id, e.auto_resolve_station, e.can_change_station
    into v_employee_status, v_default_station_id, v_auto_resolve_station, v_can_change_station
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 2. Station authorization: an employee locked to their default station
  -- may not submit a withdrawal for any other station, regardless of what
  -- the caller sent.
  if v_auto_resolve_station and not v_can_change_station then
    if p_station_id is distinct from v_default_station_id then
      raise exception 'employee % is restricted to their default station and may not use station %',
        v_employee_id, p_station_id;
    end if;
  end if;

  -- 3. Active-record validation for station/location/item. (The entered
  -- item/unit pair's inventory_item_units.is_active is already enforced by
  -- enforce_movement_line_measurement() at insert time below -- not
  -- duplicated here.)
  select s.location_id
    into v_location_id
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
   where l.id = v_location_id
     and l.is_active;

  if not found then
    raise exception 'location for station_id % is not active', p_station_id;
  end if;

  perform 1
    from public.inventory_items i
   where i.id = p_inventory_item_id
     and i.organization_id = v_org_id
     and i.status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id;
  end if;

  -- 4. business_date is derived from the station's location timezone, never
  -- a client-passed date or naive current_date (docs/DATABASE.md: "Location
  -- timezone must be explicit").
  v_business_date := (now() at time zone v_timezone)::date;

  -- 5. Movement header.
  insert into public.inventory_movements (
    organization_id, location_id, station_id, movement_type,
    performed_by_app_user_id, business_date, notes
  ) values (
    v_org_id, v_location_id, p_station_id, 'ISSUE_TO_STATION',
    p_performed_by_app_user_id, v_business_date, p_notes
  ) returning id into v_movement_id;

  -- 6. Movement line. enforce_movement_line_measurement() validates the
  -- item/unit pair and computes organization_id, base_unit_id, and
  -- normalized_base_quantity -- none of that is reimplemented here.
  insert into public.inventory_movement_lines (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  ) values (
    v_movement_id, p_inventory_item_id, p_entered_quantity, p_entered_unit_id, p_measured_base_quantity
  ) returning id, normalized_base_quantity, base_unit_id
    into v_line_id, v_normalized, v_base_unit_id;

  -- 7. HIGH_WITHDRAWAL check: station-specific rule first, else the item's
  -- org-wide default rule, else no check is possible. Strict ">" -- equal
  -- to the threshold is not an exception. Never blocks the withdrawal: the
  -- movement/line rows above are already staged for commit regardless.
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
    insert into public.exceptions (
      organization_id, exception_type, control_rule_id,
      source_movement_id, source_movement_line_id, inventory_item_id, station_id,
      observed_quantity, threshold_quantity_at_detection, base_unit_id
    ) values (
      v_org_id, 'HIGH_WITHDRAWAL', v_rule_id,
      v_movement_id, v_line_id, p_inventory_item_id, p_station_id,
      v_normalized, v_threshold, v_base_unit_id
    ) returning id into v_exception_id;
  end if;

  -- 8. Audit event.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    v_org_id, p_performed_by_app_user_id, 'INVENTORY_WITHDRAWAL_RECORDED',
    'inventory_movement', v_movement_id,
    jsonb_build_object(
      'movement_line_id', v_line_id, 'inventory_item_id', p_inventory_item_id,
      'station_id', p_station_id, 'entered_quantity', p_entered_quantity,
      'entered_unit_id', p_entered_unit_id, 'measured_base_quantity', p_measured_base_quantity,
      'normalized_base_quantity', v_normalized, 'base_unit_id', v_base_unit_id,
      'exception_id', v_exception_id
    )
  );

  return query select v_movement_id, v_line_id, v_normalized, v_base_unit_id, v_exception_id, v_exception_id is not null;
end;
$$;

revoke all on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text
) from public;

grant execute on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text
) to service_role;

-- Drop the now-unused per-employee lockout columns. failed_pin_attempts'
-- check constraint (app_users_failed_pin_attempts_check) is dropped
-- implicitly along with the column.
alter table public.app_users
  drop column failed_pin_attempts,
  drop column locked_until;
