-- Manager/Admin provisioning resumability fix.
--
-- ============================================================
-- WHY THIS MIGRATION EXISTS
-- ============================================================
-- Bug found in production use (first real Admin invite attempt): creating
-- a Manager whose Supabase Auth invite email failed (project-wide email
-- rate limit) left ONLY a bare `employees` row with no app_users row at
-- all -- the Users list then showed them as a plain "Employee / No access
-- configured", silently discarding the Admin's actual intent (Manager).
-- Root cause: the prior design had no place to record "this employee is
-- MID-WAY through becoming a Manager/Admin" independent of whether the
-- Supabase Auth call happened to succeed. This migration adds exactly
-- that -- a provisioning state that is DISTINCT from the authorization-
-- relevant role grant in user_roles (Part 10: an incomplete Manager must
-- never be silently downgraded to Employee, but also must never receive
-- usable Manager/Admin authorization before their auth account is
-- actually linked).
--
-- Three new nullable/defaulted columns on app_users, additive only:
--   intended_role       -- 'manager' | 'admin' | null. Set the moment an
--                           Admin chooses to make someone a Manager/Admin,
--                           independent of whether the invite succeeds.
--                           Never cleared by a failed invite.
--   provisioning_status -- 'none' | 'invite_pending' | 'invited' |
--                           'invite_failed'. Tracks ONLY the Auth-
--                           invitation lifecycle, deliberately separate
--                           from app_users.is_active (which continues to
--                           mean "this account is enabled," unrelated to
--                           whether onboarding finished).
--   pending_email        -- the email an invite was/is being sent to,
--                           preserved across a failed attempt so Retry
--                           Invitation never needs the Admin to retype it
--                           and never risks reusing a stale email from
--                           elsewhere.
alter table public.app_users
  add column intended_role text null,
  add column provisioning_status text not null default 'none',
  add column pending_email text null;

alter table public.app_users
  add constraint app_users_intended_role_check
  check (intended_role is null or intended_role in ('manager', 'admin'));

alter table public.app_users
  add constraint app_users_provisioning_status_check
  check (provisioning_status in ('none', 'invite_pending', 'invited', 'invite_failed'));

-- Truthful backfill for existing rows (Part 31: never guess). Any
-- app_user that already has a linked, working Auth account is genuinely
-- 'invited' (they completed onboarding); its intended_role mirrors
-- whatever role is actually granted today, since that's the only
-- evidence available. Every other existing row (kiosk-only employees,
-- and app_users with no auth_user_id at all) stays at the column
-- defaults ('none' / null) -- there is no historical evidence of an
-- in-progress Manager/Admin provisioning attempt for them, so none is
-- fabricated.
update public.app_users au
   set provisioning_status = 'invited',
       intended_role = (
         select r.name from public.user_roles ur
           join public.roles r on r.id = ur.role_id
          where ur.app_user_id = au.id and r.name in ('manager', 'admin')
          order by (r.name = 'admin') desc
          limit 1
       )
 where au.auth_user_id is not null;

-- ============================================================
-- 1. start_manager_admin_provisioning -- STEP 1 of the resumable
--    workflow (Part 9). Upserts (by employee_id, so a retry always
--    resumes the SAME app_users row, never creates a second one) the
--    intended role + target email + 'invite_pending' status, WITHOUT
--    ever touching pin_lookup_hash/pin_hash/is_active/auth_user_id --
--    an employee already holding a kiosk PIN keeps it untouched, exactly
--    like link_invited_app_user already guarantees (Part 30).
--
--    Returns the existing auth_user_id if this employee's app_users row
--    already has one linked (e.g. a stale 'invite_failed' status left
--    over from a bug, or a genuine retry after a prior success) so the
--    TypeScript caller can skip calling the Auth Admin API again
--    entirely (Part 15: never blindly re-invite when an identity is
--    already linked).
-- ============================================================
create function public.start_manager_admin_provisioning(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_email text,
  p_role_name text
)
returns table (
  out_app_user_id uuid,
  out_existing_auth_user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_status text;
  v_app_user_id uuid;
  v_existing_auth_user_id uuid;
begin
  if p_role_name not in ('manager', 'admin') then
    raise exception 'invalid role %', p_role_name using errcode = 'GA033';
  end if;

  select status into v_employee_status
    from public.employees where id = p_employee_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;
  if v_employee_status <> 'active' then
    raise exception 'reactivate this employee before granting application access' using errcode = 'GA046';
  end if;

  insert into public.app_users (organization_id, employee_id, intended_role, provisioning_status, pending_email, is_active)
  values (p_organization_id, p_employee_id, p_role_name, 'invite_pending', lower(trim(p_email)), true)
  on conflict (employee_id) do update
    set intended_role = excluded.intended_role,
        provisioning_status = 'invite_pending',
        pending_email = excluded.pending_email
  returning id, auth_user_id into v_app_user_id, v_existing_auth_user_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'APP_USER_PROVISIONING_STARTED', 'employee', p_employee_id, jsonb_build_object('role', p_role_name));

  return query select v_app_user_id, v_existing_auth_user_id;
end;
$$;

revoke all on function public.start_manager_admin_provisioning(uuid, uuid, uuid, text, text) from public;
grant execute on function public.start_manager_admin_provisioning(uuid, uuid, uuid, text, text) to service_role;

-- ============================================================
-- 2. link_invited_app_user (CREATE OR REPLACE, same signature -- no
--    drop needed) -- STEP 6A (success). Now also sets
--    provisioning_status = 'invited' and mirrors intended_role, on top
--    of its existing behavior (grant the role, never touch PIN fields).
-- ============================================================
create or replace function public.link_invited_app_user(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_auth_user_id uuid,
  p_role_name text
)
returns table (
  out_app_user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app_user_id uuid;
  v_role_id uuid;
begin
  if p_role_name not in ('manager', 'admin') then
    raise exception 'invalid role %', p_role_name using errcode = 'GA033';
  end if;

  if not exists (select 1 from public.employees where id = p_employee_id and organization_id = p_organization_id) then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;

  insert into public.app_users (organization_id, employee_id, auth_user_id, is_active, intended_role, provisioning_status)
  values (p_organization_id, p_employee_id, p_auth_user_id, true, p_role_name, 'invited')
  on conflict (employee_id) do update
    set auth_user_id = excluded.auth_user_id,
        is_active = true,
        intended_role = excluded.intended_role,
        provisioning_status = 'invited'
  returning id into v_app_user_id;

  select id into v_role_id from public.roles where name = p_role_name;

  delete from public.user_roles
   where app_user_id = v_app_user_id
     and role_id in (select id from public.roles where name in ('manager', 'admin'));
  insert into public.user_roles (app_user_id, role_id, organization_id, granted_by_app_user_id)
  values (v_app_user_id, v_role_id, p_organization_id, p_actor_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'APP_USER_INVITED', 'employee', p_employee_id, jsonb_build_object('role', p_role_name));

  return query select v_app_user_id;
end;
$$;

revoke all on function public.link_invited_app_user(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.link_invited_app_user(uuid, uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 3. mark_app_user_provisioning_failed -- STEP 6B (failure). Leaves
--    everything (employee, intended_role, pending_email, any existing
--    PIN) untouched -- flips ONLY provisioning_status, so the Admin UI
--    can show "Manager / Setup Incomplete" instead of silently reverting
--    to a plain Employee (the exact bug this migration fixes). p_reason
--    is a short safe CATEGORY (e.g. 'rate_limited', 'provider_error'),
--    never a raw provider error string or any part of the email/PIN.
-- ============================================================
create function public.mark_app_user_provisioning_failed(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app_user_id uuid;
begin
  update public.app_users
     set provisioning_status = 'invite_failed'
   where employee_id = p_employee_id
     and organization_id = p_organization_id
  returning id into v_app_user_id;

  if v_app_user_id is null then
    raise exception 'no in-progress provisioning found for employee % in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'APP_INVITE_FAILED', 'employee', p_employee_id, jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function public.mark_app_user_provisioning_failed(uuid, uuid, uuid, text) from public;
grant execute on function public.mark_app_user_provisioning_failed(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 4. list_admin_users / get_admin_user -- add the three new
--    provisioning columns so the Admin UI can render "Manager / Setup
--    Incomplete" instead of silently falling back to "Employee." Same
--    DROP + CREATE requirement as 20260811100096 (CREATE OR REPLACE
--    cannot add output columns).
-- ============================================================
drop function if exists public.list_admin_users(uuid, text, text, text);

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
  out_has_pin boolean,
  out_intended_role text,
  out_provisioning_status text,
  out_pending_email text,
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
    au.pin_lookup_hash is not null,
    au.intended_role,
    coalesce(au.provisioning_status, 'none'),
    au.pending_email,
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

drop function if exists public.get_admin_user(uuid, uuid);

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
  out_has_pin boolean,
  out_intended_role text,
  out_provisioning_status text,
  out_pending_email text,
  out_roles text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id, e.first_name, e.last_name, e.status, e.default_station_id, st.name,
    au.id, au.is_active, au.auth_user_id is not null, au.pin_lookup_hash is not null,
    au.intended_role, coalesce(au.provisioning_status, 'none'), au.pending_email,
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
