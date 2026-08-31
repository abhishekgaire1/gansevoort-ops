-- Kiosk station assignment enforcement -- fixes a confirmed authorization
-- defect found during real employee UAT: after PIN login, the kiosk
-- displayed EVERY active organization station (including TEST RPC fixture
-- stations), regardless of which station(s) the employee was actually
-- assigned to.
--
-- Root cause, confirmed by direct inspection (both layers were broken):
--   1. UI/data layer: listActiveStationsForOrganization
--      (app/lib/kiosk/stations.ts) queried every active station for the
--      organization with NO per-employee filter at all.
--   2. Server authorization: record_inventory_withdrawal /
--      record_inventory_withdrawal_batch (20260811100112, and every
--      earlier version) only restricted the submitted station when an
--      employee was BOTH auto_resolve_station=true AND
--      can_change_station=false (the "locked" combination). Every other
--      employee -- any "must_pick" employee (auto_resolve_station=false,
--      the schema's own default), or any "auto_changeable" employee
--      (can_change_station=true) -- could submit a withdrawal for ANY
--      active station in the organization, with no assignment check
--      whatsoever. This is the actual authorization bypass: the UI bug
--      alone would only have been a confusing display issue, but this
--      RPC gap meant a manually-altered station_id (or simply picking any
--      station from the over-broad list) was silently accepted.
--
-- The schema also had no genuine multi-station assignment concept --
-- employees.default_station_id (20260811100008) is a single nullable
-- column, not a relationship table -- so "multiple assigned active
-- stations" (a required behavior here) could not previously be
-- represented at all. This migration is additive/forward-only --
-- 100001-100129 are already applied and are not edited. It:
--
--   1. Adds employee_station_assignments -- the new authoritative
--      employee<->station relationship, composite-FK'd to both employees
--      and stations (never a plain single-column FK), soft-deactivatable
--      (is_active) rather than hard-deleted so "who was assigned what,
--      and when it changed" stays visible for audit, matching this
--      schema's existing convention (stations.is_active, vendors.is_active,
--      app_users.is_active) over destructive deletes for this class of
--      relationship.
--   2. Backfills exactly one assignment row per employee who already has
--      a default_station_id set -- this is what makes today's real,
--      already-correctly-configured single-station employees (including
--      the employee whose UAT surfaced this bug) keep working immediately
--      without any manual reconfiguration; it reads their own existing
--      configuration, it does not alter it.
--   3. Adds manager_set_employee_station_assignments -- the ONLY way an
--      Admin's station-assignment save is now persisted: takes the
--      complete desired set of station ids for an employee, activates
--      exactly those (validating each is an active station in the same
--      organization), deactivates any previously-active assignment not in
--      the new set, and writes one audit event with the before/after
--      station id lists.
--   4. Adds list_employee_station_assignments -- the one authoritative
--      read both the kiosk (station picker) and the Admin employee detail
--      page use: active assignments to active stations only, for exactly
--      one employee in exactly one organization. Cross-organization and
--      inactive/deleted/fixture stations can never appear because both
--      the assignment row AND the station row are required active AND
--      same-organization.
--   5. Hardens record_inventory_withdrawal / record_inventory_withdrawal_
--      batch (exact-copy-then-patched from their current 20260811100112
--      bodies, signatures unchanged): the narrow "locked employee" check
--      is replaced with an unconditional requirement that the submitted
--      station be an active employee_station_assignments row for that
--      employee, in the same organization, joined to an active station --
--      for EVERY employee, with no flag-driven exception and no broad
--      manager/role bypass invented. default_station_id/
--      auto_resolve_station/can_change_station on employees are no longer
--      read by ANY authorization path after this migration (left in place
--      rather than dropped, to avoid an unrelated destructive schema
--      change on a live table with real employee data in the same
--      migration as the actual security fix; a future migration may
--      retire them once the new model is fully adopted).

-- ============================================================
-- 1. employee_station_assignments
-- ============================================================
create table public.employee_station_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  employee_id uuid not null,
  station_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by_app_user_id uuid,
  deactivated_at timestamptz,
  constraint employee_station_assignments_employee_org_fk foreign key (employee_id, organization_id)
    references public.employees (id, organization_id),
  constraint employee_station_assignments_station_org_fk foreign key (station_id, organization_id)
    references public.stations (id, organization_id)
);

-- One row per (employee, station) ever -- reactivating a previously
-- removed assignment flips is_active back to true on the SAME row rather
-- than inserting a duplicate.
create unique index employee_station_assignments_employee_station_key
  on public.employee_station_assignments (employee_id, station_id);

create index employee_station_assignments_org_employee_active_idx
  on public.employee_station_assignments (organization_id, employee_id)
  where is_active;

alter table public.employee_station_assignments enable row level security;
-- Deny-by-default: no policies for anon/authenticated -- same as every
-- other table in this schema. All access flows through service-role
-- server code (the kiosk Server Actions, the Admin station-assignment
-- action), gated by kiosk-token verification or requireManagerOrAdmin().

-- Backfill: exactly one assignment per employee who already has a
-- default_station_id -- idempotent (safe to rerun), and it reads each
-- employee's own pre-existing configuration rather than altering it.
insert into public.employee_station_assignments (organization_id, employee_id, station_id, is_active)
select e.organization_id, e.id, e.default_station_id, true
  from public.employees e
 where e.default_station_id is not null
   and not exists (
     select 1 from public.employee_station_assignments esa
      where esa.employee_id = e.id and esa.station_id = e.default_station_id
   );

-- ============================================================
-- 2. manager_set_employee_station_assignments -- the only way an Admin's
--    station-assignment save is persisted (replaces set_employee_
--    default_station's role for kiosk-authorization purposes; that RPC
--    is left in place unmodified since it only ever wrote the now-
--    superseded default_station_id column, which this migration does not
--    remove).
-- ============================================================
create or replace function public.manager_set_employee_station_assignments(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_station_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_invalid_count integer;
  v_distinct_count integer;
  v_requested_count integer;
begin
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id and e.organization_id = p_organization_id
  ) then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id;
  end if;

  v_requested_count := coalesce(array_length(p_station_ids, 1), 0);
  select count(distinct x) into v_distinct_count from unnest(p_station_ids) as x;
  if v_distinct_count <> v_requested_count then
    raise exception 'p_station_ids must not contain duplicates';
  end if;

  select count(*) into v_invalid_count
    from unnest(p_station_ids) as station_id
   where not exists (
     select 1 from public.stations s where s.id = station_id and s.organization_id = p_organization_id and s.is_active
   );
  if v_invalid_count > 0 then
    raise exception 'one or more station ids are not active stations in organization %', p_organization_id
      using errcode = 'GA074';
  end if;

  select coalesce(jsonb_agg(esa.station_id), '[]'::jsonb)
    into v_before
    from public.employee_station_assignments esa
   where esa.employee_id = p_employee_id and esa.organization_id = p_organization_id and esa.is_active;

  -- Activate (or reactivate) exactly the requested stations.
  insert into public.employee_station_assignments (organization_id, employee_id, station_id, is_active, created_by_app_user_id)
  select p_organization_id, p_employee_id, station_id, true, p_actor_app_user_id
    from unnest(p_station_ids) as station_id
  on conflict (employee_id, station_id)
  do update set is_active = true, deactivated_at = null, created_by_app_user_id = excluded.created_by_app_user_id;

  -- Deactivate any previously-active assignment not in the new desired set.
  update public.employee_station_assignments esa
     set is_active = false, deactivated_at = now()
   where esa.employee_id = p_employee_id
     and esa.organization_id = p_organization_id
     and esa.is_active
     and not (esa.station_id = any (p_station_ids));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'EMPLOYEE_STATION_ASSIGNMENTS_SET', 'employee', p_employee_id,
    jsonb_build_object('stationIds', v_before),
    jsonb_build_object('stationIds', to_jsonb(p_station_ids))
  );
end;
$$;

revoke all on function public.manager_set_employee_station_assignments(uuid, uuid, uuid, uuid[]) from public;
grant execute on function public.manager_set_employee_station_assignments(uuid, uuid, uuid, uuid[]) to service_role;

-- ============================================================
-- 3. list_employee_station_assignments -- the one authoritative read.
--    Cross-organization, inactive, deleted, and fixture stations can
--    never appear: both the assignment row and the station row must be
--    active AND in the caller-supplied organization.
-- ============================================================
create or replace function public.list_employee_station_assignments(
  p_organization_id uuid,
  p_employee_id uuid
)
returns table (out_station_id uuid, out_station_name text, out_station_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.name, s.code
    from public.employee_station_assignments esa
    join public.stations s on s.id = esa.station_id
   where esa.organization_id = p_organization_id
     and esa.employee_id = p_employee_id
     and esa.is_active
     and s.organization_id = p_organization_id
     and s.is_active
   order by s.name;
$$;

revoke all on function public.list_employee_station_assignments(uuid, uuid) from public;
grant execute on function public.list_employee_station_assignments(uuid, uuid) to service_role;

-- ============================================================
-- 4. record_inventory_withdrawal / record_inventory_withdrawal_batch --
--    exact-copy-then-patched from 20260811100112's current bodies.
--    Signatures unchanged; the only change in each is the station-
--    authorization check.
-- ============================================================
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
  v_item_name text;
  v_station_name text;
  v_unit_code text;
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

  select e.status
    into v_employee_status
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization (kiosk station assignment enforcement):
  -- the submitted station must be one this employee is ACTIVELY ASSIGNED
  -- to, in the SAME organization -- checked independently of anything the
  -- caller claims, with no bypass for any employee/role. A manually
  -- altered or never-assigned station_id is rejected here regardless of
  -- what the kiosk UI happened to display.
  if not exists (
    select 1
      from public.employee_station_assignments esa
      join public.stations s on s.id = esa.station_id
     where esa.employee_id = v_employee_id
       and esa.station_id = p_station_id
       and esa.organization_id = v_org_id
       and esa.is_active
       and s.organization_id = v_org_id
       and s.is_active
  ) then
    raise exception 'employee % is not assigned to active station %', v_employee_id, p_station_id
      using errcode = 'GA073';
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
  -- the authoritative current (PRE-withdrawal) balance -- no client-side
  -- availability check is ever trusted, and no mutable balance row
  -- exists to lock instead. Transaction-scoped: released automatically
  -- at commit/rollback.
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_source_location_id));
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_source_location_id);

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
  -- item/unit pair FIRST (a wrong/packaging unit or a missing required
  -- measurement fails HERE, before availability is ever consulted) and
  -- computes organization_id, base_unit_id, and normalized_base_quantity
  -- authoritatively -- the availability check right after uses THIS
  -- real, trigger-computed value, never an approximation of it.
  insert into public.inventory_movement_lines as ml (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  ) values (
    v_movement_id, p_inventory_item_id, p_entered_quantity, p_entered_unit_id, p_measured_base_quantity
  ) returning ml.id, ml.normalized_base_quantity, ml.base_unit_id
    into v_line_id, v_normalized, v_base_unit_id;

  -- 7b. Availability check against the AUTHORITATIVE normalized
  -- quantity. Raising here rolls back the movement header and line
  -- inserted above -- this whole RPC call is one transaction, so an
  -- exception at any point means neither row is ever visible to any
  -- other session; "no partial movement ever written" holds regardless
  -- of where in this function the rejection happens.
  if v_normalized > v_current_balance then
    -- Structured detail (never parsed from prose) so the kiosk can
    -- render the exact required message ("Only N UNIT are currently
    -- available in LOCATION.") without regexing the human-readable text.
    raise exception 'only % is currently available for inventory_item % at location % (requested %)',
      v_current_balance, p_inventory_item_id, p_source_location_id, v_normalized
      using errcode = 'GA022',
            detail = jsonb_build_object(
              'availableQuantity', v_current_balance,
              'requestedQuantity', v_normalized
            )::text;
  end if;

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

    -- RC1 High-Withdrawal Manager Visibility -- notify every OTHER
    -- active manager/admin in the org, same broadcast shape as
    -- complete_cycle_count (20260811100084) / record_inventory_waste
    -- (20260811100088). Fires only here, on a genuine first-time
    -- creation -- both replay branches above already `return` before
    -- this point, so a retried/duplicate submission never sends a
    -- second notification. Purely informational: this can never block
    -- or delay the withdrawal, which is already fully recorded above.
    select i.name into v_item_name from public.inventory_items i where i.id = p_inventory_item_id;
    select s.name into v_station_name from public.stations s where s.id = p_station_id;
    select u.code into v_unit_code from public.units u where u.id = v_base_unit_id;

    insert into public.user_notifications (
      organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
    )
    select v_org_id, recipient.app_user_id, 'HIGH_WITHDRAWAL', 'exception', v_exception_id,
      'High withdrawal recorded',
      format('%s %s of %s withdrawn at %s (threshold %s %s).', v_normalized, v_unit_code, v_item_name, v_station_name, v_threshold, v_unit_code),
      jsonb_build_object(
        'exceptionId', v_exception_id,
        'inventoryItemId', p_inventory_item_id,
        'stationId', p_station_id,
        'observedQuantity', v_normalized,
        'thresholdQuantity', v_threshold,
        'performedByAppUserId', p_performed_by_app_user_id
      )
      from (
        select distinct au.id as app_user_id
          from public.app_users au
          join public.user_roles ur on ur.app_user_id = au.id
          join public.roles r on r.id = ur.role_id
         where au.organization_id = v_org_id
           and au.is_active
           and r.name in ('manager', 'admin')
           and au.id <> p_performed_by_app_user_id
      ) recipient;
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

create or replace function public.record_inventory_withdrawal_batch(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_client_request_id uuid,
  p_cart_lines jsonb,
  p_notes text default null
)
returns table (
  out_withdrawal_batch_id uuid,
  out_movement_id uuid,
  out_movement_line_id uuid,
  out_inventory_item_id uuid,
  out_source_location_id uuid,
  out_normalized_base_quantity numeric,
  out_base_unit_id uuid,
  out_exception_id uuid,
  out_exception_raised boolean,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
  v_employee_status text;
  v_station_location_id uuid;
  v_timezone text;
  v_business_date date;
  v_batch_id uuid;
  v_existing_batch_id uuid;
  v_existing_actor uuid;
  v_existing_station uuid;
  v_mismatch boolean;
  v_lock_key bigint;
  v_insufficient jsonb;
  v_line_count integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select count(*) into v_line_count from public.normalize_withdrawal_batch_cart_lines(p_cart_lines);
  if coalesce(v_line_count, 0) = 0 then
    raise exception 'p_cart_lines must contain at least one line';
  end if;

  -- 1. Resolve and validate the acting employee. Never trust
  -- organization_id from the caller.
  select au.organization_id, au.employee_id
    into v_org_id, v_employee_id
    from public.app_users au
   where au.id = p_performed_by_app_user_id
     and au.is_active;

  if not found then
    raise exception 'performed_by_app_user_id % is not an active app user', p_performed_by_app_user_id;
  end if;

  -- 2. Batch-level idempotency (ONE client_request_id for the whole
  -- checkout, Part 18). A retry must match the original actor/station
  -- and, once normalized, the original SET of cart lines -- reordered
  -- but otherwise identical is still identical; anything else fails
  -- closed rather than silently replaying (or worse, extending) a
  -- different checkout.
  select b.id, b.performed_by_app_user_id, b.station_id
    into v_existing_batch_id, v_existing_actor, v_existing_station
    from public.inventory_withdrawal_batches b
   where b.organization_id = v_org_id
     and b.client_request_id = p_client_request_id;

  if found then
    if v_existing_actor is distinct from p_performed_by_app_user_id
       or v_existing_station is distinct from p_station_id
    then
      raise exception 'client_request_id % was already used by a different actor or station', p_client_request_id;
    end if;

    select
      exists (
        select c.out_inventory_item_id, c.out_source_location_id, c.out_entered_unit_id, c.out_entered_quantity, c.out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
        except
        select ml.inventory_item_id, im.location_id, ml.entered_unit_id, ml.entered_quantity, ml.measured_base_quantity
          from public.inventory_movement_lines ml
          join public.inventory_movements im on im.id = ml.movement_id
         where im.withdrawal_batch_id = v_existing_batch_id
      )
      or exists (
        select ml.inventory_item_id, im.location_id, ml.entered_unit_id, ml.entered_quantity, ml.measured_base_quantity
          from public.inventory_movement_lines ml
          join public.inventory_movements im on im.id = ml.movement_id
         where im.withdrawal_batch_id = v_existing_batch_id
        except
        select c.out_inventory_item_id, c.out_source_location_id, c.out_entered_unit_id, c.out_entered_quantity, c.out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
      )
      into v_mismatch;

    if v_mismatch then
      raise exception 'client_request_id % was already used with a different withdrawal batch payload', p_client_request_id;
    end if;

    return query
      select v_existing_batch_id, im.id, ml.id, ml.inventory_item_id, im.location_id,
             ml.normalized_base_quantity, ml.base_unit_id, ex.id, ex.id is not null, true
        from public.inventory_movement_lines ml
        join public.inventory_movements im on im.id = ml.movement_id
        left join public.exceptions ex on ex.source_movement_line_id = ml.id
       where im.withdrawal_batch_id = v_existing_batch_id
       order by im.location_id, ml.id;
    return;
  end if;

  select e.status
    into v_employee_status
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization (kiosk station assignment enforcement) --
  -- identical rule to the single-item RPC. Every movement in a batch
  -- shares one station (Part 8: everything in one submission belongs to
  -- the same current session station); the submitted station must be one
  -- this employee is ACTIVELY ASSIGNED to, in the SAME organization, with
  -- no bypass for any employee/role.
  if not exists (
    select 1
      from public.employee_station_assignments esa
      join public.stations s on s.id = esa.station_id
     where esa.employee_id = v_employee_id
       and esa.station_id = p_station_id
       and esa.organization_id = v_org_id
       and esa.is_active
       and s.organization_id = v_org_id
       and s.is_active
  ) then
    raise exception 'employee % is not assigned to active station %', v_employee_id, p_station_id
      using errcode = 'GA073';
  end if;

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

  v_business_date := (now() at time zone v_timezone)::date;

  -- 4. Per-line structural validation (Part 14 -- never trust the
  -- browser to have deduplicated OR validated correctly), before
  -- acquiring any locks: every source location must be active and
  -- storage-eligible, every item must be an active item in this org.
  if exists (
    select 1
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     where not exists (
       select 1 from public.locations l
        where l.id = c.out_source_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible
     )
  ) then
    raise exception 'one or more source locations in the batch are not active, storage-eligible locations in organization %', v_org_id
      using errcode = 'GA021';
  end if;

  if exists (
    select 1
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     where not exists (
       select 1 from public.inventory_items i
        where i.id = c.out_inventory_item_id and i.organization_id = v_org_id and i.status = 'active'
     )
  ) then
    raise exception 'one or more items in the batch are not active items in organization %', v_org_id;
  end if;

  -- 5. Deterministic, globally-consistent lock acquisition (Part 15):
  -- every UNIQUE (item, source location) pair in the batch, sorted
  -- ascending by the SAME shared inventory_location_lock_key(...) every
  -- other availability-sensitive RPC uses -- never browser/payload
  -- order. A batch touching Item A/Loc X, Item B/Loc Y, Item C/Loc X
  -- cannot deadlock against a concurrent withdrawal/transfer that
  -- happens to touch the same locations in a different order, because
  -- every caller that ever needs more than one of these locks acquires
  -- them in this one global total order.
  for v_lock_key in
    select distinct public.inventory_location_lock_key(v_org_id, c.out_inventory_item_id, c.out_source_location_id)
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  -- 6. Batch header -- ONE row per employee checkout action. Carries no
  -- quantity/item data; the ledger below remains the sole authority.
  insert into public.inventory_withdrawal_batches (
    organization_id, performed_by_app_user_id, station_id, client_request_id
  ) values (
    v_org_id, p_performed_by_app_user_id, p_station_id, p_client_request_id
  ) returning id into v_batch_id;

  -- 7. One ISSUE_TO_STATION movement per DISTINCT source location
  -- touched by the batch (Part 13 -- location_id must remain exactly
  -- the physical location one movement affects; a batch spanning
  -- locations cannot be one movement).
  insert into public.inventory_movements (
    organization_id, location_id, station_id, movement_type,
    performed_by_app_user_id, business_date, notes, location_attribution, withdrawal_batch_id
  )
  select v_org_id, locs.out_source_location_id, p_station_id, 'ISSUE_TO_STATION',
         p_performed_by_app_user_id, v_business_date, p_notes, 'EXACT', v_batch_id
    from (select distinct c.out_source_location_id from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c) locs;

  -- 8. One movement line per normalized cart line, attached to its
  -- location's movement header. enforce_movement_line_measurement()
  -- (unchanged, existing trigger) validates the item/unit pair FIRST and
  -- computes the authoritative normalized_base_quantity -- never
  -- reimplemented here, exactly like the single-item RPC.
  insert into public.inventory_movement_lines (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  )
  select im.id, c.out_inventory_item_id, c.out_entered_quantity, c.out_entered_unit_id, c.out_measured_base_quantity
    from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
    join public.inventory_movements im
      on im.withdrawal_batch_id = v_batch_id and im.location_id = c.out_source_location_id;

  -- 9. Authoritative availability re-check (Part 16), AFTER every
  -- line's real, trigger-computed normalized_base_quantity is known
  -- (same ordering fix as 20260811100076). The balance formula here is
  -- the SAME three-term formula as inventory_location_item_balance,
  -- with one addition: it explicitly excludes THIS batch's own just-
  -- inserted outbound rows (m2.withdrawal_batch_id is distinct from
  -- v_batch_id), which is what gives the correct pre-withdrawal balance
  -- without needing to snapshot anything before step 8's inserts.
  -- Pre-existing rows (legacy, or written by the single-item RPC, which
  -- never sets withdrawal_batch_id) are correctly still counted as prior
  -- outbound activity. ALL short lines are collected, not just the
  -- first, and the raise below rolls back the ENTIRE transaction --
  -- every insert this call made, across every location -- so nothing
  -- ever partially commits.
  select jsonb_agg(jsonb_build_object(
           'inventoryItemId', x.inventory_item_id,
           'sourceLocationId', x.location_id,
           'availableQuantity', x.available_quantity,
           'requestedQuantity', x.requested_quantity
         ))
    into v_insufficient
    from (
      select ml.inventory_item_id, im.location_id,
             sum(ml.normalized_base_quantity) as requested_quantity,
             coalesce((
               select sum(ml2.normalized_base_quantity)
                 from public.inventory_movement_lines ml2
                 join public.inventory_movements m2 on m2.id = ml2.movement_id
                where m2.organization_id = v_org_id
                  and m2.location_id = im.location_id
                  and ml2.inventory_item_id = ml.inventory_item_id
                  and m2.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
             ), 0)
             - coalesce((
               select sum(ml2.normalized_base_quantity)
                 from public.inventory_movement_lines ml2
                 join public.inventory_movements m2 on m2.id = ml2.movement_id
                where m2.organization_id = v_org_id
                  and m2.location_id = im.location_id
                  and ml2.inventory_item_id = ml.inventory_item_id
                  and m2.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
                  and m2.location_attribution = 'EXACT'
                  and m2.withdrawal_batch_id is distinct from v_batch_id
             ), 0)
             - coalesce((
               select a.allocated_outbound_quantity
                 from public.inventory_legacy_location_allocations a
                where a.organization_id = v_org_id
                  and a.inventory_item_id = ml.inventory_item_id
                  and a.location_id = im.location_id
             ), 0) as available_quantity
        from public.inventory_movement_lines ml
        join public.inventory_movements im on im.id = ml.movement_id
       where im.withdrawal_batch_id = v_batch_id
       group by ml.inventory_item_id, im.location_id
    ) x
   where x.requested_quantity > x.available_quantity;

  if v_insufficient is not null then
    raise exception 'insufficient inventory for one or more items in this batch'
      using errcode = 'GA022', detail = v_insufficient::text;
  end if;

  -- 10. HIGH_WITHDRAWAL, per line -- station-specific rule preferred
  -- over the item's org-wide default rule, exactly as the single-item
  -- RPC resolves it. Never blocks: every insert above is already staged
  -- for commit regardless of this step.
  insert into public.exceptions (
    organization_id, exception_type, control_rule_id,
    source_movement_id, source_movement_line_id, inventory_item_id, station_id,
    observed_quantity, threshold_quantity_at_detection, base_unit_id
  )
  select v_org_id, 'HIGH_WITHDRAWAL', r.rule_id,
         im.id, ml.id, ml.inventory_item_id, p_station_id,
         ml.normalized_base_quantity, r.threshold_quantity, ml.base_unit_id
    from public.inventory_movement_lines ml
    join public.inventory_movements im on im.id = ml.movement_id
    join lateral (
      select cr.id as rule_id, cr.threshold_quantity
        from public.control_rules cr
       where cr.organization_id = v_org_id
         and cr.inventory_item_id = ml.inventory_item_id
         and cr.rule_type = 'HIGH_WITHDRAWAL'
         and cr.is_active
         and (cr.station_id = p_station_id or cr.station_id is null)
       order by (cr.station_id is null)
       limit 1
    ) r on true
   where im.withdrawal_batch_id = v_batch_id
     and ml.normalized_base_quantity > r.threshold_quantity;

  -- 10b. RC1 High-Withdrawal Manager Visibility -- one notification per
  -- eligible recipient per NEW exception created in step 10 above (a
  -- batch touching several over-threshold lines can create several
  -- exceptions; each gets its own broadcast, never collapsed into one
  -- per batch). Every exception this query finds was necessarily just
  -- created above -- v_batch_id is brand new (step 6), so no exception
  -- from an earlier call could possibly reference a movement under it.
  -- The whole replay branch above already returns before this point, so
  -- a retried/duplicate submission never sends a second notification
  -- either. Purely informational: nothing here can affect the batch,
  -- which is already fully recorded.
  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  )
  select v_org_id, recipient.app_user_id, 'HIGH_WITHDRAWAL', 'exception', ex.id,
    'High withdrawal recorded',
    format('%s %s of %s withdrawn at %s (threshold %s %s).', ex.observed_quantity, u.code, i.name, s.name, ex.threshold_quantity_at_detection, u.code),
    jsonb_build_object(
      'exceptionId', ex.id,
      'inventoryItemId', ex.inventory_item_id,
      'stationId', ex.station_id,
      'observedQuantity', ex.observed_quantity,
      'thresholdQuantity', ex.threshold_quantity_at_detection,
      'performedByAppUserId', p_performed_by_app_user_id
    )
    from public.exceptions ex
    join public.inventory_movements im on im.id = ex.source_movement_id
    join public.inventory_items i on i.id = ex.inventory_item_id
    join public.stations s on s.id = ex.station_id
    join public.units u on u.id = ex.base_unit_id
    cross join (
      select distinct au.id as app_user_id
        from public.app_users au
        join public.user_roles ur on ur.app_user_id = au.id
        join public.roles r on r.id = ur.role_id
       where au.organization_id = v_org_id
         and au.is_active
         and r.name in ('manager', 'admin')
         and au.id <> p_performed_by_app_user_id
    ) recipient
   where im.withdrawal_batch_id = v_batch_id;

  -- 11. One audit event for the whole batch checkout (Part 27) -- a
  -- compact index into the ledger (who / station / batch / movements /
  -- items / locations / when), not a duplicate of it.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  )
  select v_org_id, p_performed_by_app_user_id, 'INVENTORY_WITHDRAWAL_BATCH_RECORDED',
         'inventory_withdrawal_batch', v_batch_id,
         jsonb_build_object(
           'stationId', p_station_id,
           'clientRequestId', p_client_request_id,
           'lines', jsonb_agg(jsonb_build_object(
             'movementId', im.id, 'movementLineId', ml.id, 'inventoryItemId', ml.inventory_item_id,
             'sourceLocationId', im.location_id, 'normalizedBaseQuantity', ml.normalized_base_quantity,
             'baseUnitId', ml.base_unit_id
           ))
         )
    from public.inventory_movement_lines ml
    join public.inventory_movements im on im.id = ml.movement_id
   where im.withdrawal_batch_id = v_batch_id;

  return query
    select v_batch_id, im.id, ml.id, ml.inventory_item_id, im.location_id,
           ml.normalized_base_quantity, ml.base_unit_id, ex.id, ex.id is not null, false
      from public.inventory_movement_lines ml
      join public.inventory_movements im on im.id = ml.movement_id
      left join public.exceptions ex on ex.source_movement_line_id = ml.id
     where im.withdrawal_batch_id = v_batch_id
     order by im.location_id, ml.id;
end;
$$;

-- ============================================================
-- 5. New app-defined SQLSTATEs, continuing the project-wide GA0xx
--    sequence (highest in use before this migration: GA072).
-- ============================================================
-- GA073 EMPLOYEE_NOT_ASSIGNED_TO_STATION (record_inventory_withdrawal /
--   record_inventory_withdrawal_batch: the submitted station is not an
--   active assignment for this employee)
-- GA074 INVALID_STATION_ASSIGNMENT (manager_set_employee_station_
--   assignments: one or more requested station ids are not active
--   stations in the caller's organization)
