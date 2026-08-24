-- Identity + Access Management milestone -- kiosk PIN lifecycle
-- (collision-safe create/reset/reactivate) and the schema fix that makes
-- Manager/Admin application accounts (email/password) actually
-- representable without forcing a meaningless kiosk PIN on them.
--
-- ============================================================
-- WHY pin_hash/pin_lookup_hash MUST BECOME NULLABLE
-- ============================================================
-- Verified against the live schema before writing this migration:
-- app_users.pin_hash/pin_lookup_hash are currently NOT NULL (set at
-- table creation, 20260811100003, never relaxed since). That was correct
-- when every app_user was a kiosk employee, but this milestone's own
-- product principle is EMPLOYEE -> kiosk PIN, MANAGER/ADMIN -> email +
-- password -- a Manager/Admin app_user genuinely has no PIN at all, and
-- inventing one they can never legitimately be told would be exactly the
-- kind of fake credential this project's PIN security model forbids.
-- Both columns become nullable together, with a CHECK enforcing they are
-- either both null (no kiosk access) or both set (real kiosk access) --
-- never one without the other. This is a pure relaxation of an existing
-- constraint (NOT NULL -> nullable), so it can never conflict with
-- existing data (every current row already has both set).
alter table public.app_users alter column pin_lookup_hash drop not null;
alter table public.app_users alter column pin_hash drop not null;

alter table public.app_users
  add constraint app_users_pin_fields_together_check
  check ((pin_lookup_hash is null) = (pin_hash is null));

-- ============================================================
-- WHY THE PIN UNIQUENESS CONSTRAINT IS BEING NARROWED
-- ============================================================
-- app_users_org_pin_lookup_key (20260811100003) is a FULL unique
-- constraint on (organization_id, pin_lookup_hash) -- it treats an
-- INACTIVE employee's old PIN as permanently reserved forever, which
-- this milestone's target lifecycle explicitly rejects (Part 11/44): an
-- inactive employee cannot authenticate, so their old PIN should
-- normally be assignable to a different active employee, while
-- reactivating the inactive one must then be checked for a fresh
-- collision at that moment.
--
-- Audited the live DEV data before making this change (never skipped,
-- Part 10/59): 58 app_users currently have a PIN, 0 duplicate
-- (organization_id, pin_lookup_hash) pairs exist even among ALL rows
-- (active and inactive combined) -- the existing full constraint already
-- proves this. Narrowing to an active-only partial index is therefore
-- STRICTLY WEAKER than what's already enforced and can never fail
-- against current data.
--
-- The partial predicate is is_active (app_users' own column) only, not a
-- join to employees.status -- Postgres partial indexes cannot reference
-- another table. This is safe in practice because set_employee_status
-- (20260811100094) already keeps app_users.is_active in lockstep with
-- employees.status for every status change made through this schema's
-- own sanctioned path.
alter table public.app_users drop constraint app_users_org_pin_lookup_key;

create unique index app_users_org_active_pin_lookup_key
  on public.app_users (organization_id, pin_lookup_hash)
  where is_active and pin_lookup_hash is not null;

-- ============================================================
-- 1. set_employee_kiosk_pin -- the ONE authoritative path for setting OR
--    resetting an employee's kiosk PIN (Part 43: create/reset/enable-
--    kiosk-access all funnel through here). Upserts app_users keyed by
--    employee_id (already UNIQUE) so this is naturally idempotent:
--    calling it again with a different PIN simply resets again, never
--    creates a second identity for the same employee.
--
-- Hashing happens in the TypeScript caller using the exact same
-- hashPinLookup/hashPinForStorage helpers every other PIN-writing path
-- already trusts (Argon2id + HMAC-pepper) -- this RPC only ever receives
-- already-computed hashes, never a raw PIN, and never returns one.
-- ============================================================
create function public.set_employee_kiosk_pin(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_employee_id uuid,
  p_pin_lookup_hash text,
  p_pin_hash text
)
returns table (
  out_app_user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_status text;
  v_app_user_id uuid;
begin
  select status into v_employee_status
    from public.employees where id = p_employee_id and organization_id = p_organization_id
    for update;
  if not found then
    raise exception 'employee % not found in organization %', p_employee_id, p_organization_id using errcode = 'GA034';
  end if;
  if v_employee_status <> 'active' then
    raise exception 'reactivate this employee before setting a kiosk PIN' using errcode = 'GA045';
  end if;

  begin
    insert into public.app_users (organization_id, employee_id, pin_lookup_hash, pin_hash, pin_set_at, is_active)
    values (p_organization_id, p_employee_id, p_pin_lookup_hash, p_pin_hash, now(), true)
    on conflict (employee_id) do update
      set pin_lookup_hash = excluded.pin_lookup_hash,
          pin_hash = excluded.pin_hash,
          pin_set_at = now(),
          is_active = true
    returning id into v_app_user_id;
  exception when unique_violation then
    raise exception 'that PIN is already in use by another active user' using errcode = 'GA043';
  end;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'KIOSK_PIN_RESET', 'employee', p_employee_id, jsonb_build_object('appUserId', v_app_user_id));

  return query select v_app_user_id;
end;
$$;

revoke all on function public.set_employee_kiosk_pin(uuid, uuid, uuid, text, text) from public;
grant execute on function public.set_employee_kiosk_pin(uuid, uuid, uuid, text, text) to service_role;

-- ============================================================
-- 2. set_employee_status (CREATE OR REPLACE, same signature as
--    20260811100094 -- no drop needed) -- adds the reactivation PIN-
--    collision check (Part 11/44) on top of the existing last-admin and
--    self-protection logic, which is preserved verbatim.
-- ============================================================
create or replace function public.set_employee_status(
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
  v_own_pin_lookup_hash text;
  v_conflicting_app_user_id uuid;
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

  select au.id, au.pin_lookup_hash, exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
     where ur.app_user_id = au.id and r.name = 'admin'
  ) into v_app_user_id, v_own_pin_lookup_hash, v_is_admin
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

  -- Reactivation PIN-collision check (Part 11/44): only relevant when
  -- reactivating an app_user that has a stored PIN -- if that exact PIN
  -- lookup value now belongs to a DIFFERENT active app_user in this org,
  -- reactivating would either violate app_users_org_active_pin_lookup_key
  -- outright or (if the constraint somehow didn't catch it) create
  -- ambiguous kiosk identity. Checked explicitly, before the update, so
  -- the error is the specific, actionable GA044 rather than a raw
  -- constraint violation.
  if p_status = 'active' and v_app_user_id is not null and v_own_pin_lookup_hash is not null then
    select au2.id into v_conflicting_app_user_id
      from public.app_users au2
     where au2.organization_id = p_organization_id
       and au2.is_active
       and au2.pin_lookup_hash = v_own_pin_lookup_hash
       and au2.id <> v_app_user_id;

    if v_conflicting_app_user_id is not null then
      raise exception 'this employee''s existing kiosk PIN is now assigned to another active user -- reset the PIN before reactivating kiosk access'
        using errcode = 'GA044';
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

-- Grants are unaffected by CREATE OR REPLACE with an unchanged signature,
-- but re-asserted here defensively/explicitly for clarity.
revoke all on function public.set_employee_status(uuid, uuid, uuid, text) from public;
grant execute on function public.set_employee_status(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 3. link_invited_app_user -- the LOCAL half of inviting a Manager/Admin
--    (Part 22/23). Supabase Auth account creation itself
--    (auth.admin.inviteUserByEmail) can only happen in the TypeScript
--    caller, server-side -- SQL cannot call the Auth Admin API. This RPC
--    only links an already-created-or-resolved auth_user_id to an
--    employee's app_users row and grants the requested role, atomically,
--    and is safe to call again for the SAME employee (upsert keyed by
--    employee_id, Part 50's "resend must not duplicate") -- it never
--    touches pin_lookup_hash/pin_hash, so an employee being promoted
--    from kiosk-only to Manager/Admin keeps their existing PIN/kiosk
--    access untouched (Part 30).
-- ============================================================
create function public.link_invited_app_user(
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

  insert into public.app_users (organization_id, employee_id, auth_user_id, is_active)
  values (p_organization_id, p_employee_id, p_auth_user_id, true)
  on conflict (employee_id) do update
    set auth_user_id = excluded.auth_user_id,
        is_active = true
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
