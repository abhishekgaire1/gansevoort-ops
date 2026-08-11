-- Withdrawal idempotency
--
-- A network failure can occur after Postgres commits but before the browser
-- receives the response. Without protection, a kiosk employee retrying a
-- failed-looking submission could create a second inventory movement for a
-- withdrawal that already succeeded. This migration adds a client-supplied
-- idempotency key so a retried record_inventory_withdrawal() call either
-- replays the original successful result (no new rows) or, if the same key
-- is reused with a different payload, fails closed rather than silently
-- returning an unrelated movement.
--
-- client_request_id is added as a NULLABLE column at the table level so
-- existing historical/test inventory_movements rows (client_request_id is
-- null) remain valid -- the NOT NULL requirement is enforced one layer up,
-- inside record_inventory_withdrawal() itself, which is the only sanctioned
-- write path into this table. This keeps the historical append-only data
-- untouched while every *new* kiosk withdrawal is required to supply a key.
--
-- One column on the existing inventory_movements table (not a new table):
-- V1 is one item per withdrawal submission, so one movement row is already
-- the natural unit of idempotency, and a dedicated idempotency-key table
-- would be a duplicate concept for the same relationship.

alter table public.inventory_movements
  add column client_request_id uuid;

-- Organization + client_request_id uniquely identifies a request. Partial
-- (not a plain unique constraint) because historical/other rows may have
-- client_request_id = null, and multiple such rows must remain legal.
create unique index inventory_movements_org_client_request_id_key
  on public.inventory_movements (organization_id, client_request_id)
  where client_request_id is not null;

-- Signature is changing (a new required-by-business-logic parameter), so
-- the old 7-argument function is dropped rather than replaced in place --
-- leaving both would create an ambiguous overload for any caller that still
-- invokes the 7-argument form.
drop function if exists public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text
);

create function public.record_inventory_withdrawal(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_inventory_item_id uuid,
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
  v_existing record;
begin
  -- The column stays nullable at the table level for historical/test data,
  -- but every withdrawal created through this function -- the only
  -- sanctioned write path -- must supply one. Type-checked as uuid by
  -- Postgres before this body even runs, so "valid" is enforced by the
  -- parameter type itself; this check only covers "present."
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

  -- 2. Idempotency check. organization_id is always v_org_id (server-derived
  -- above, never client-supplied), so this lookup can only ever find a
  -- movement that already belongs to the caller's own organization -- an
  -- idempotency key can never resolve to another organization's, another
  -- employee's, or another withdrawal's result by construction, not just by
  -- convention. A retry must match the ORIGINAL request on every
  -- security/business-significant field -- actor, station, item, entered
  -- unit, entered quantity, and measured_base_quantity (including null vs.
  -- non-null, which "is distinct from" handles correctly) -- or the call
  -- fails closed instead of silently replaying a different withdrawal.
  select im.id as existing_movement_id,
         im.performed_by_app_user_id as existing_performed_by_app_user_id,
         im.station_id as existing_station_id,
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

  -- 4. Active-record validation for station/location/item. (The entered
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

  -- 5. business_date is derived from the station's location timezone, never
  -- a client-passed date or naive current_date (docs/DATABASE.md: "Location
  -- timezone must be explicit").
  v_business_date := (now() at time zone v_timezone)::date;

  -- 6. Movement header. Wrapped in its own sub-block: two genuinely
  -- concurrent retries with the same client_request_id can both pass the
  -- idempotency check above (neither has committed yet) and both reach this
  -- insert. The partial unique index lets only one succeed; the other hits
  -- unique_violation here, at which point the winner has necessarily
  -- already committed (Postgres blocks the loser's insert on the winner's
  -- uncommitted row, then raises unique_violation once the winner commits),
  -- so re-running the same lookup-and-compare-and-return logic below always
  -- sees a complete, committed row -- both concurrent callers end up
  -- returning the identical successful result instead of one of them
  -- failing outright.
  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id
    ) values (
      v_org_id, v_location_id, p_station_id, 'ISSUE_TO_STATION',
      p_performed_by_app_user_id, v_business_date, p_notes, p_client_request_id
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    select im.id as existing_movement_id,
           im.performed_by_app_user_id as existing_performed_by_app_user_id,
           im.station_id as existing_station_id,
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
      -- Unreachable in practice (the unique_violation was on this exact
      -- key), but fail loudly rather than silently returning nothing.
      raise exception 'client_request_id % conflicted but no matching movement was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_performed_by_app_user_id is distinct from p_performed_by_app_user_id
       or v_existing.existing_station_id is distinct from p_station_id
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
  -- normalized_base_quantity -- none of that is reimplemented here. Insert
  -- target aliased (as ml) and RETURNING list qualified with it, per the
  -- fix in 20260811100014 (normalized_base_quantity/base_unit_id are also
  -- this function's RETURNS TABLE output parameter names).
  insert into public.inventory_movement_lines as ml (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  ) values (
    v_movement_id, p_inventory_item_id, p_entered_quantity, p_entered_unit_id, p_measured_base_quantity
  ) returning ml.id, ml.normalized_base_quantity, ml.base_unit_id
    into v_line_id, v_normalized, v_base_unit_id;

  -- 8. HIGH_WITHDRAWAL check: station-specific rule first, else the item's
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
      'station_id', p_station_id, 'entered_quantity', p_entered_quantity,
      'entered_unit_id', p_entered_unit_id, 'measured_base_quantity', p_measured_base_quantity,
      'normalized_base_quantity', v_normalized, 'base_unit_id', v_base_unit_id,
      'exception_id', v_exception_id, 'client_request_id', p_client_request_id
    )
  );

  return query select v_movement_id, v_line_id, v_normalized, v_base_unit_id, v_exception_id, v_exception_id is not null, false;
end;
$$;

revoke all on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) from public;

grant execute on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) to service_role;
