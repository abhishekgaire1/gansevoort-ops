-- Admin Foundation milestone -- Users (employees/app_users/roles) and
-- Stations administration. No new tables: employees, app_users, roles,
-- user_roles, stations, and audit_events already model everything this
-- milestone needs (verified against the live schema before writing this
-- file). Purely additive RPCs, following this schema's existing
-- conventions exactly: security definer, set search_path = '', GA0xx
-- domain error codes, audit_events for every consequential change,
-- service_role-only execute grants.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================
-- It does not create Supabase Auth accounts. Creating an authenticated
-- Manager/Admin login (email/password, invite flow) is NOT safely
-- supported by any existing code path -- the only precedent
-- (scripts/dev-seed.ts's findOrCreateAuthUser) calls
-- supabase.auth.admin.createUser with a plaintext password printed to a
-- terminal, which is a dev-only bootstrap technique, never something to
-- expose through a production Admin UI. create_employee below therefore
-- only ever creates an OPERATIONAL employee (+ optional kiosk PIN access
-- via app_users), never an application login. Promoting an EXISTING
-- authenticated app_user (one that already has auth_user_id set) to
-- Manager/Admin is supported via set_user_role; granting Manager/Admin
-- to an app_user with no auth_user_id is rejected server-side (GA039) --
-- it would be a capability nobody could actually exercise, since
-- requireManagerOrAdmin() requires a real Supabase Auth session first.

-- ============================================================
-- 1. list_admin_users -- Admin -> Users hub.
-- ============================================================
create function public.list_admin_users(
  p_organization_id uuid,
  p_search text default null,
  p_role text default null,
  p_status text default null
)
returns table (
  out_employee_id uuid,
  out_first_name text,
  out_last_name text,
  out_employee_status text,
  out_default_station_id uuid,
  out_default_station_name text,
  out_app_user_id uuid,
  out_is_app_user_active boolean,
  out_has_auth_account boolean,
  out_roles text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id,
    e.first_name,
    e.last_name,
    e.status,
    e.default_station_id,
    st.name,
    au.id,
    au.is_active,
    au.auth_user_id is not null,
    coalesce(
      (select array_agg(r.name order by r.name) from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.app_user_id = au.id),
      array[]::text[]
    )
  from public.employees e
  left join public.stations st on st.id = e.default_station_id
  left join public.app_users au on au.employee_id = e.id
  where e.organization_id = p_organization_id
    and (p_search is null or btrim(p_search) = '' or (e.first_name || ' ' || e.last_name) ilike '%' || p_search || '%')
    and (p_status is null or e.status = p_status)
    and (
      p_role is null
      or (p_role = 'employee' and not exists (
            select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
             where ur.app_user_id = au.id and r.name in ('manager', 'admin')
          ))
      or (p_role in ('manager', 'admin') and exists (
            select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
             where ur.app_user_id = au.id and r.name = p_role
          ))
    )
  order by e.first_name, e.last_name;
$$;

revoke all on function public.list_admin_users(uuid, text, text, text) from public;
grant execute on function public.list_admin_users(uuid, text, text, text) to service_role;

-- ============================================================
-- 2. get_admin_user -- Users detail.
-- ============================================================
create function public.get_admin_user(
  p_organization_id uuid,
  p_employee_id uuid
)
returns table (
  out_employee_id uuid,
  out_first_name text,
  out_last_name text,
  out_employee_status text,
  out_default_station_id uuid,
  out_default_station_name text,
  out_app_user_id uuid,
  out_is_app_user_active boolean,
  out_has_auth_account boolean,
  out_roles text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id, e.first_name, e.last_name, e.status, e.default_station_id, st.name,
    au.id, au.is_active, au.auth_user_id is not null,
    coalesce(
      (select array_agg(r.name order by r.name) from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.app_user_id = au.id),
      array[]::text[]
    )
  from public.employees e
  left join public.stations st on st.id = e.default_station_id
  left join public.app_users au on au.employee_id = e.id
  where e.organization_id = p_organization_id and e.id = p_employee_id;
$$;

revoke all on function public.get_admin_user(uuid, uuid) from public;
grant execute on function public.get_admin_user(uuid, uuid) to service_role;

-- ============================================================
-- 3. create_employee -- operational employee, optionally with kiosk PIN
--    access. PIN hashing (Argon2id + HMAC lookup) happens in the caller
--    (app/lib/auth/pin.ts, same helpers every other PIN-writing path
--    already uses) -- this RPC only ever receives already-computed
--    hashes, never a raw PIN, and never touches auth.users.
-- ============================================================
create function public.create_employee(
  p_organization_id uuid,
  p_created_by_app_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_default_station_id uuid,
  p_grant_kiosk_access boolean,
  p_pin_lookup_hash text,
  p_pin_hash text
)
returns table (
  out_employee_id uuid,
  out_app_user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid;
  v_app_user_id uuid;
  v_role_id uuid;
begin
  if btrim(coalesce(p_first_name, '')) = '' or btrim(coalesce(p_last_name, '')) = '' then
    raise exception 'first and last name are required' using errcode = 'GA033';
  end if;

  if p_default_station_id is not null and not exists (
    select 1 from public.stations where id = p_default_station_id and organization_id = p_organization_id and is_active
  ) then
    raise exception 'default station % is not a valid active station for organization %', p_default_station_id, p_organization_id
      using errcode = 'GA037';
  end if;

  insert into public.employees (organization_id, first_name, last_name, default_station_id, status)
  values (p_organization_id, btrim(p_first_name), btrim(p_last_name), p_default_station_id, 'active')
  returning id into v_employee_id;

  if p_grant_kiosk_access then
    begin
      insert into public.app_users (organization_id, employee_id, pin_lookup_hash, pin_hash)
      values (p_organization_id, v_employee_id, p_pin_lookup_hash, p_pin_hash)
      returning id into v_app_user_id;
    exception when unique_violation then
      raise exception 'that PIN is already in use by another employee in this organization' using errcode = 'GA038';
    end;

    select id into v_role_id from public.roles where name = 'employee';
    if v_role_id is not null then
      insert into public.user_roles (app_user_id, role_id, organization_id, granted_by_app_user_id)
      values (v_app_user_id, v_role_id, p_organization_id, p_created_by_app_user_id);
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_created_by_app_user_id, 'EMPLOYEE_CREATED', 'employee', v_employee_id,
    jsonb_build_object(
      'firstName', btrim(p_first_name), 'lastName', btrim(p_last_name),
      'defaultStationId', p_default_station_id, 'kioskAccessGranted', p_grant_kiosk_access
    )
  );

  return query select v_employee_id, v_app_user_id;
end;
$$;

revoke all on function public.create_employee(uuid, uuid, text, text, uuid, boolean, text, text) from public;
grant execute on function public.create_employee(uuid, uuid, text, text, uuid, boolean, text, text) to service_role;

-- ============================================================
-- 4. update_employee_name
-- ============================================================
create function public.update_employee_name(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_first_name text,
  p_last_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_first text;
  v_old_last text;
begin
  if btrim(coalesce(p_first_name, '')) = '' or btrim(coalesce(p_last_name, '')) = '' then
    raise exception 'first and last name are required' using errcode = 'GA033';
  end if;

  select first_name, last_name into v_old_first, v_old_last
    from public.employees where id = p_employee_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;

  update public.employees set first_name = btrim(p_first_name), last_name = btrim(p_last_name)
   where id = p_employee_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'EMPLOYEE_RENAMED', 'employee', p_employee_id,
    jsonb_build_object('firstName', v_old_first, 'lastName', v_old_last),
    jsonb_build_object('firstName', btrim(p_first_name), 'lastName', btrim(p_last_name))
  );
end;
$$;

revoke all on function public.update_employee_name(uuid, uuid, uuid, text, text) from public;
grant execute on function public.update_employee_name(uuid, uuid, uuid, text, text) to service_role;

-- ============================================================
-- 5. set_employee_default_station
-- ============================================================
create function public.set_employee_default_station(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_station_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_station_id uuid;
begin
  if p_station_id is not null and not exists (
    select 1 from public.stations where id = p_station_id and organization_id = p_organization_id and is_active
  ) then
    raise exception 'station % is not a valid active station for organization %', p_station_id, p_organization_id
      using errcode = 'GA037';
  end if;

  select default_station_id into v_old_station_id
    from public.employees where id = p_employee_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;

  update public.employees set default_station_id = p_station_id
   where id = p_employee_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'EMPLOYEE_DEFAULT_STATION_CHANGED', 'employee', p_employee_id,
    jsonb_build_object('defaultStationId', v_old_station_id), jsonb_build_object('defaultStationId', p_station_id)
  );
end;
$$;

revoke all on function public.set_employee_default_station(uuid, uuid, uuid, uuid) from public;
grant execute on function public.set_employee_default_station(uuid, uuid, uuid, uuid) to service_role;

-- ============================================================
-- 6. set_employee_status -- ACTIVE/INACTIVE lifecycle (never delete,
--    Part 11). Keeps employees.status and app_users.is_active in sync
--    (see Part 47's kiosk-gap finding in the final report: PIN
--    verification currently only reads app_users.is_active, so this
--    RPC deliberately writes BOTH flags together going forward rather
--    than leaving them to drift). Enforces last-admin and self-
--    deactivation protection server-side (Parts 15-16).
-- ============================================================
create function public.set_employee_status(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app_user_id uuid;
  v_is_admin boolean;
  v_active_admin_count integer;
  v_actor_employee_id uuid;
begin
  if p_status not in ('active', 'inactive') then
    raise exception 'invalid employee status %', p_status using errcode = 'GA033';
  end if;

  if not exists (select 1 from public.employees where id = p_employee_id and organization_id = p_organization_id) then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;

  select employee_id into v_actor_employee_id from public.app_users where id = p_actor_app_user_id;
  if p_status = 'inactive' and v_actor_employee_id = p_employee_id then
    raise exception 'you cannot deactivate your own account' using errcode = 'GA036';
  end if;

  select au.id, exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
     where ur.app_user_id = au.id and r.name = 'admin'
  ) into v_app_user_id, v_is_admin
    from public.app_users au where au.employee_id = p_employee_id;

  if p_status = 'inactive' and v_is_admin then
    select count(*) into v_active_admin_count
      from public.app_users au
      join public.employees e on e.id = au.employee_id
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id
     where au.organization_id = p_organization_id and au.is_active and e.status = 'active' and r.name = 'admin';

    if v_active_admin_count <= 1 then
      raise exception 'at least one active Admin is required' using errcode = 'GA035';
    end if;
  end if;

  update public.employees set status = p_status where id = p_employee_id and organization_id = p_organization_id;

  if v_app_user_id is not null then
    update public.app_users set is_active = (p_status = 'active') where id = v_app_user_id;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'EMPLOYEE_STATUS_CHANGED', 'employee', p_employee_id, jsonb_build_object('status', p_status));
end;
$$;

revoke all on function public.set_employee_status(uuid, uuid, uuid, text) from public;
grant execute on function public.set_employee_status(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 7. set_user_role -- exactly one of employee/manager/admin (replaces
--    any existing manager/admin grant; the vestigial "employee" role row
--    some app_users have is left untouched either way since nothing
--    currently reads it for authorization -- kiosk PIN verification
--    never checks user_roles at all). Requires an existing authenticated
--    account (auth_user_id) to grant manager/admin -- granting elevated
--    access to an app_user who could never actually log in to exercise
--    it would be misleading (Part 8/38).
-- ============================================================
create function public.set_user_role(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_app_user_id uuid,
  p_role_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_auth_account boolean;
  v_new_role_id uuid;
  v_was_admin boolean;
  v_active_admin_count integer;
begin
  if p_role_name not in ('employee', 'manager', 'admin') then
    raise exception 'invalid role %', p_role_name using errcode = 'GA033';
  end if;

  if p_app_user_id = p_actor_app_user_id then
    raise exception 'you cannot change your own role' using errcode = 'GA036';
  end if;

  select auth_user_id is not null into v_has_auth_account
    from public.app_users where id = p_app_user_id and organization_id = p_organization_id;
  if not found then
    raise exception 'user % not found in organization %', p_app_user_id, p_organization_id using errcode = 'GA034';
  end if;

  if p_role_name in ('manager', 'admin') and not v_has_auth_account then
    raise exception 'this employee has no application login account -- Manager/Admin access requires one' using errcode = 'GA039';
  end if;

  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
     where ur.app_user_id = p_app_user_id and r.name = 'admin'
  ) into v_was_admin;

  if v_was_admin and p_role_name <> 'admin' then
    select count(*) into v_active_admin_count
      from public.app_users au
      join public.employees e on e.id = au.employee_id
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id
     where au.organization_id = p_organization_id and au.is_active and e.status = 'active' and r.name = 'admin';

    if v_active_admin_count <= 1 then
      raise exception 'at least one active Admin is required' using errcode = 'GA035';
    end if;
  end if;

  select id into v_new_role_id from public.roles where name = p_role_name;

  delete from public.user_roles
   where app_user_id = p_app_user_id
     and role_id in (select id from public.roles where name in ('manager', 'admin'));

  if p_role_name in ('manager', 'admin') then
    insert into public.user_roles (app_user_id, role_id, organization_id, granted_by_app_user_id)
    values (p_app_user_id, v_new_role_id, p_organization_id, p_actor_app_user_id);
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'USER_ROLE_CHANGED', 'app_user', p_app_user_id, jsonb_build_object('role', p_role_name));
end;
$$;

revoke all on function public.set_user_role(uuid, uuid, uuid, text) from public;
grant execute on function public.set_user_role(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 8. list_admin_stations -- Admin -> Stations hub. default_employee_count
--    is exactly what set_station_status's dependency check evaluates,
--    computed the same way here so the list and the block message never
--    disagree.
-- ============================================================
create function public.list_admin_stations(
  p_organization_id uuid,
  p_search text default null,
  p_status text default null
)
returns table (
  out_station_id uuid,
  out_name text,
  out_code text,
  out_is_active boolean,
  out_default_employee_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.name, s.code, s.is_active,
    (
      select count(*)::integer from public.employees e
       where e.default_station_id = s.id and e.organization_id = p_organization_id and e.status = 'active'
    )
  from public.stations s
  where s.organization_id = p_organization_id
    and (p_search is null or btrim(p_search) = '' or s.name ilike '%' || p_search || '%')
    and (
      p_status is null
      or (p_status = 'active' and s.is_active)
      or (p_status = 'inactive' and not s.is_active)
    )
  order by s.name;
$$;

revoke all on function public.list_admin_stations(uuid, text, text) from public;
grant execute on function public.list_admin_stations(uuid, text, text) to service_role;

-- ============================================================
-- 9. get_admin_station
-- ============================================================
create function public.get_admin_station(
  p_organization_id uuid,
  p_station_id uuid
)
returns table (
  out_station_id uuid,
  out_name text,
  out_code text,
  out_is_active boolean,
  out_default_employee_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.name, s.code, s.is_active,
    (
      select count(*)::integer from public.employees e
       where e.default_station_id = s.id and e.organization_id = p_organization_id and e.status = 'active'
    )
  from public.stations s
  where s.organization_id = p_organization_id and s.id = p_station_id;
$$;

revoke all on function public.get_admin_station(uuid, uuid) from public;
grant execute on function public.get_admin_station(uuid, uuid) to service_role;

-- ============================================================
-- 10. create_station -- reuses the org's existing primary location (this
--     schema has no multi-location station picker anywhere yet; every
--     current station belongs to whichever location the org was seeded
--     with). Duplicate names are already rejected at the database level
--     by stations_location_lower_name_key (case-insensitive, per
--     location) -- this just maps that unique_violation to a clear
--     message, and separately distinguishes "an ACTIVE station already
--     has this name" from "an INACTIVE one does" so the caller can
--     offer reactivation instead of a raw duplicate error (Part 28).
-- ============================================================
create function public.create_station(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_name text
)
returns table (
  out_station_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_normalized text := btrim(p_name);
  v_existing_id uuid;
  v_existing_active boolean;
  v_station_id uuid;
begin
  if v_normalized = '' then
    raise exception 'station name is required' using errcode = 'GA033';
  end if;

  select id into v_location_id from public.locations where organization_id = p_organization_id order by created_at limit 1;
  if v_location_id is null then
    raise exception 'organization % has no location to attach a station to', p_organization_id using errcode = 'GA034';
  end if;

  select id, is_active into v_existing_id, v_existing_active
    from public.stations
   where location_id = v_location_id and lower(name) = lower(v_normalized);

  if v_existing_id is not null then
    if v_existing_active then
      raise exception 'a station named "%" already exists', v_normalized using errcode = 'GA040';
    else
      raise exception 'an inactive station named "%" already exists -- reactivate it instead', v_normalized
        using errcode = 'GA041', detail = jsonb_build_object('existingStationId', v_existing_id)::text;
    end if;
  end if;

  begin
    insert into public.stations (organization_id, location_id, name, is_active)
    values (p_organization_id, v_location_id, v_normalized, true)
    returning id into v_station_id;
  exception when unique_violation then
    raise exception 'a station named "%" already exists', v_normalized using errcode = 'GA040';
  end;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'STATION_CREATED', 'station', v_station_id, jsonb_build_object('name', v_normalized));

  return query select v_station_id;
end;
$$;

revoke all on function public.create_station(uuid, uuid, text) from public;
grant execute on function public.create_station(uuid, uuid, text) to service_role;

-- ============================================================
-- 11. update_station_name -- same station id, historical movements
--     (inventory_movements.station_id) are untouched (Part 23).
-- ============================================================
create function public.update_station_name(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_station_id uuid,
  p_new_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_old_name text;
  v_normalized text := btrim(p_new_name);
  v_duplicate_id uuid;
begin
  if v_normalized = '' then
    raise exception 'station name is required' using errcode = 'GA033';
  end if;

  select location_id, name into v_location_id, v_old_name
    from public.stations where id = p_station_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'station % not found in organization %', p_station_id, p_organization_id using errcode = 'GA034';
  end if;

  select id into v_duplicate_id
    from public.stations
   where location_id = v_location_id and lower(name) = lower(v_normalized) and id <> p_station_id;
  if v_duplicate_id is not null then
    raise exception 'a station named "%" already exists', v_normalized using errcode = 'GA040';
  end if;

  update public.stations set name = v_normalized where id = p_station_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_actor_app_user_id, 'STATION_RENAMED', 'station', p_station_id,
          jsonb_build_object('name', v_old_name), jsonb_build_object('name', v_normalized));
end;
$$;

revoke all on function public.update_station_name(uuid, uuid, uuid, text) from public;
grant execute on function public.update_station_name(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 12. set_station_status -- deactivation BLOCKS if active employees
--     still use this station as their default (Part 25) -- never
--     silently reassigns/nulls their default. Reactivation always
--     succeeds (same station id, Part 27).
-- ============================================================
create function public.set_station_status(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_station_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dependent_count integer;
begin
  if not exists (select 1 from public.stations where id = p_station_id and organization_id = p_organization_id) then
    raise exception 'station % not found in organization %', p_station_id, p_organization_id using errcode = 'GA034';
  end if;

  if not p_is_active then
    select count(*) into v_dependent_count
      from public.employees
     where default_station_id = p_station_id and organization_id = p_organization_id and status = 'active';

    if v_dependent_count > 0 then
      raise exception '% active employees currently use this station as their default station', v_dependent_count
        using errcode = 'GA042', detail = jsonb_build_object('activeEmployeeCount', v_dependent_count)::text;
    end if;
  end if;

  update public.stations set is_active = p_is_active where id = p_station_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'STATION_STATUS_CHANGED', 'station', p_station_id,
          jsonb_build_object('isActive', p_is_active));
end;
$$;

revoke all on function public.set_station_status(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_station_status(uuid, uuid, uuid, boolean) to service_role;
