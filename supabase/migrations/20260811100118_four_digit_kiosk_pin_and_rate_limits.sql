-- Four-digit employee kiosk PIN: forced-reset transition + layered,
-- DB-backed rate limiting.
--
-- NUMBERING NOTE: this file was originally drafted as 20260811100113 on
-- this branch (feature/four-digit-kiosk-pin), in parallel with an
-- UNRELATED purchase-versus-usage-unit model developed on a sibling
-- branch (feature/purchase-usage-units) that independently claimed
-- 20260811100113-20260811100117. Renumbered to 20260811100118 to resolve
-- that collision -- this branch does not itself contain 100113-100117
-- (they exist only on the sibling branch until both are merged onto a
-- shared integration branch); this migration's own forward-only DDL is
-- unchanged from its original 100113 draft, only the filename/ordering
-- changed. The eventual combined sequence is 100113-100117 (purchase/
-- usage units) then 100118 (this file, four-digit kiosk PIN) -- this
-- file must never be applied standalone ahead of that combined sequence.
--
-- ============================================================
-- WHY A FORCED RESET, NOT A DUAL-FORMAT TRANSITION
-- ============================================================
-- app_users.pin_hash is an Argon2id hash -- by design, it cannot reveal
-- how many characters the original PIN had. There is therefore no safe
-- way to tell, from stored data alone, which existing accounts hold a
-- six-digit PIN and which (if any, going forward) hold a four-digit one.
-- Rather than guess, EVERY app_user row that currently has a PIN
-- configured (pin_hash is not null) is explicitly marked
-- kiosk_pin_reset_required = true below -- a deliberate, honest signal
-- that a manager must assign a fresh four-digit PIN before that employee
-- can use the kiosk again. No PIN is read, transformed, derived, or
-- guessed at any point in this migration.
--
-- kiosk_pin_format_version distinguishes "the currently supported format"
-- from "a format that predates this feature" -- it is NOT a general
-- version history, just a two-state marker (LEGACY_SIX_DIGIT vs
-- FOUR_DIGIT) that the kiosk lookup query (app/lib/auth/verifyPin.ts)
-- filters on directly, so a legacy hash can never authenticate even if a
-- six-digit-shaped request somehow reached the server (the TypeScript
-- format validator already rejects that earlier, but this is a second,
-- independent, server-side backstop).
--
-- ============================================================
-- 1. PIN format/reset metadata
-- ============================================================
alter table public.app_users
  add column kiosk_pin_format_version text not null default 'FOUR_DIGIT',
  add column kiosk_pin_reset_required boolean not null default false;

alter table public.app_users
  add constraint app_users_kiosk_pin_format_version_check
  check (kiosk_pin_format_version in ('LEGACY_SIX_DIGIT', 'FOUR_DIGIT'));

-- Safe legacy backfill: only rows that actually have a PIN configured are
-- touched. A Manager/Admin-only app_user (pin_hash is null, Identity +
-- Access Management milestone) has no kiosk PIN at all and is correctly
-- left alone -- format/reset-required are meaningless for it either way,
-- since hasPin already reports false for it in every UI that reads these
-- fields.
update public.app_users
   set kiosk_pin_format_version = 'LEGACY_SIX_DIGIT',
       kiosk_pin_reset_required = true
 where pin_hash is not null;

-- ============================================================
-- 2. set_employee_kiosk_pin -- extended to atomically flip format/reset
--    metadata alongside the hashes it already writes. Same 5-parameter
--    signature (CREATE OR REPLACE is safe here, no drop needed) -- the
--    caller already only ever sends a TypeScript-validated four-digit PIN
--    through app/lib/auth/pin.ts's isValidPinFormat, so every write this
--    function performs is, by construction, a genuine four-digit
--    assignment. The existing INSERT ... ON CONFLICT (employee_id) DO
--    UPDATE is already ONE atomic statement -- adding two more columns to
--    both branches keeps that atomicity guarantee intact, so hash +
--    format + reset-required can never be observed out of sync with each
--    other, even under concurrent callers.
-- ============================================================
create or replace function public.set_employee_kiosk_pin(
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
    insert into public.app_users (
      organization_id, employee_id, pin_lookup_hash, pin_hash, pin_set_at, is_active,
      kiosk_pin_format_version, kiosk_pin_reset_required
    )
    values (
      p_organization_id, p_employee_id, p_pin_lookup_hash, p_pin_hash, now(), true,
      'FOUR_DIGIT', false
    )
    on conflict (employee_id) do update
      set pin_lookup_hash = excluded.pin_lookup_hash,
          pin_hash = excluded.pin_hash,
          pin_set_at = now(),
          is_active = true,
          kiosk_pin_format_version = 'FOUR_DIGIT',
          kiosk_pin_reset_required = false
    returning id into v_app_user_id;
  exception when unique_violation then
    raise exception 'that PIN is already in use by another active user' using errcode = 'GA043';
  end;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'KIOSK_PIN_RESET', 'employee', p_employee_id,
    jsonb_build_object('appUserId', v_app_user_id, 'formatVersion', 'FOUR_DIGIT')
  );

  return query select v_app_user_id;
end;
$$;

revoke all on function public.set_employee_kiosk_pin(uuid, uuid, uuid, text, text) from public;
grant execute on function public.set_employee_kiosk_pin(uuid, uuid, uuid, text, text) to service_role;

-- ============================================================
-- 3. list_admin_users / get_admin_user -- extended with
--    out_kiosk_pin_reset_required so the Admin Users UI can distinguish
--    "PIN reset required" (legacy, blocked at the kiosk) from "Kiosk PIN
--    active" (current four-digit format) without ever exposing the PIN
--    or either hash. Only true when a PIN actually exists; an app_user
--    with no PIN at all (pin_hash null) always reports false here, same
--    as out_has_pin already does for that case. CREATE OR REPLACE cannot
--    add an output column, so both are dropped and recreated, exactly as
--    20260811100096 already did when out_has_pin was first added.
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
  out_kiosk_pin_reset_required boolean,
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
    au.pin_hash is not null and au.kiosk_pin_reset_required,
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
  out_kiosk_pin_reset_required boolean,
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
    au.pin_hash is not null and au.kiosk_pin_reset_required,
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
-- 4. Layered, DB-backed PIN-verification rate limiting.
-- ============================================================
-- The existing single-scope pin_verify_rate_limits (20260811100009,
-- 20 attempts / 5 minutes, source-IP-only) is not sufficient for a
-- four-digit space (10,000 possible values vs. six digits' 1,000,000).
-- Adds a `scope` column so the SAME table now holds four independent
-- layered counters instead of duplicating the table four times:
--   'device'          -- signed, server-issued kiosk/browser cookie identifier
--   'ip'               -- trusted platform-derived source IP (unchanged source)
--   'org'              -- organization-wide ceiling
--   'ip_all_attempts'  -- separate, higher-volume ALL-attempts throttle
--                         (bounds total Argon2/CPU work regardless of
--                         pass/fail; conceptually distinct from the three
--                         failed-attempt security scopes above -- see
--                         app/lib/auth/rateLimit.ts's own module comment).
-- Existing rows (all necessarily from the prior single-scope design) are
-- backfilled to scope = 'ip', preserving their original meaning exactly.
--
-- DELIBERATELY NOT PART OF THE PRIMARY KEY (correction from this
-- migration's first draft, which added scope to the primary key and
-- rewrote the ON CONFLICT target to match -- that would have broken the
-- OLD, already-deployed increment_pin_rate_limit(uuid, text, integer)
-- during any migration-applied-but-old-app-still-running window: an old
-- caller's INSERT ... ON CONFLICT (organization_id, rate_limit_key,
-- window_start) would no longer match ANY unique constraint once the
-- primary key gained a fourth column, raising "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" on every
-- single PIN attempt served by an old instance -- i.e. the migration
-- itself, not a deployment mistake, would have taken down kiosk login
-- the instant it was applied). Keeping the ORIGINAL three-column primary
-- key (organization_id, rate_limit_key, window_start) untouched means the
-- old function's ON CONFLICT target remains valid forever, so old app
-- instances keep working unchanged through the entire migration-first
-- rollout. Scope isolation is instead guaranteed at the DATA level: every
-- caller of increment_pin_rate_limit/get the current count is required
-- (see app/lib/auth/rateLimit.ts's deriveRateLimitKey, which now takes
-- scope as a mandatory parameter) to hash the scope name INTO
-- rate_limit_key before ever reaching this table, so two different
-- scopes can never produce the same rate_limit_key value for the same
-- organization/window -- collision is prevented by construction, not by
-- a constraint that would have broken backward compatibility. `scope`
-- itself remains purely for human/operational visibility (e.g. "count
-- rows grouped by scope" without reversing any hash).
alter table public.pin_verify_rate_limits
  add column scope text not null default 'ip';

alter table public.pin_verify_rate_limits
  add constraint pin_verify_rate_limits_scope_check
  check (scope in ('device', 'ip', 'org', 'ip_all_attempts'));

-- increment_pin_rate_limit -- extended with a trailing defaulted p_scope
-- parameter, via a bare CREATE OR REPLACE (no DROP). Because the
-- parameter LIST differs from the existing three-parameter function,
-- Postgres does NOT replace it in place -- it adds a SECOND overload,
-- and the OLD three-parameter overload keeps existing, unchanged,
-- forever (until a future migration explicitly drops it once every
-- instance is confirmed running new code). This is intentional here,
-- not the ambiguous-overload bug this codebase has hit and fixed
-- elsewhere: PostgREST/Postgres resolve a NAMED-parameter call
-- deterministically by exact parameter-name match, preferring the
-- candidate needing the FEWEST defaults filled in. An old caller
-- supplying exactly {p_organization_id, p_rate_limit_key,
-- p_window_seconds} (never p_scope, since old code doesn't know it
-- exists) matches the OLD three-parameter overload exactly (zero
-- defaults) and can never resolve to this new one; a new caller always
-- supplies p_scope explicitly (see rateLimit.ts) and therefore can only
-- match THIS overload (the old one has no such parameter at all). Since
-- the primary key/ON CONFLICT target is unchanged (see this section's
-- own comment above), the untouched old overload's body continues to
-- execute correctly against the new schema -- verified line-by-line
-- against the current old-function body on record in
-- 20260811100009_pin_rate_limits.sql, which is not and must not be
-- edited.
create or replace function public.increment_pin_rate_limit(
  p_organization_id uuid,
  p_rate_limit_key text,
  p_window_seconds integer,
  p_scope text default 'ip'
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_attempt_count integer;
begin
  if p_scope not in ('device', 'ip', 'org', 'ip_all_attempts') then
    raise exception 'invalid rate limit scope %', p_scope;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.pin_verify_rate_limits (organization_id, scope, rate_limit_key, window_start, attempt_count)
  values (p_organization_id, p_scope, p_rate_limit_key, v_window_start, 1)
  on conflict (organization_id, rate_limit_key, window_start)
    do update set attempt_count = public.pin_verify_rate_limits.attempt_count + 1,
                  scope = excluded.scope
  returning attempt_count into v_attempt_count;

  return v_attempt_count;
end;
$$;

revoke all on function public.increment_pin_rate_limit(uuid, text, integer, text) from public;
grant execute on function public.increment_pin_rate_limit(uuid, text, integer, text) to service_role;

-- reset_pin_rate_limit_scope -- used ONLY to clear the DEVICE scope's
-- current-window counter on a successful login (app/lib/auth/verifyPin.ts).
-- Deliberately callable for any scope (never hardcoded to 'device' here)
-- so the constraint that only the device scope is ever reset lives in the
-- TypeScript caller, matching this schema's general preference for
-- policy in application code and mechanism in SQL -- but the caller
-- contract is documented here precisely because getting this wrong would
-- violate "successful login must not erase organization-wide attack
-- evidence" (Section 8 of the approved plan): only ever call this with
-- p_scope = 'device'. A brand-new function (no prior overload, no
-- backward-compatibility constraint) -- old app instances never call
-- this at all, since it did not exist before this migration.
create or replace function public.reset_pin_rate_limit_scope(
  p_organization_id uuid,
  p_scope text,
  p_rate_limit_key text,
  p_window_seconds integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz;
begin
  if p_scope not in ('device', 'ip', 'org', 'ip_all_attempts') then
    raise exception 'invalid rate limit scope %', p_scope;
  end if;

  -- Only the CURRENT window (computed with the SAME bucketing formula
  -- increment_pin_rate_limit uses, so this always targets the exact row
  -- an in-flight window's counter lives in) is cleared -- older windows
  -- are inert history already (the increment RPC never reads them), so
  -- leaving them untouched costs nothing and keeps this a single, cheap
  -- statement rather than an unbounded delete. Matching on rate_limit_key
  -- alone (already scope-prefixed before hashing -- see this section's
  -- own comment above) is sufficient to identify the exact row; scope is
  -- included in the WHERE clause too as a redundant, harmless defense-in-
  -- depth check, never load-bearing for correctness.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  delete from public.pin_verify_rate_limits
   where organization_id = p_organization_id
     and scope = p_scope
     and rate_limit_key = p_rate_limit_key
     and window_start = v_window_start;
end;
$$;

revoke all on function public.reset_pin_rate_limit_scope(uuid, text, text, integer) from public;
grant execute on function public.reset_pin_rate_limit_scope(uuid, text, text, integer) to service_role;

-- ============================================================
-- 5. register_pin_verification_failure -- closes a genuine TOCTOU race in
--    the device/ip/org FAILURE scopes.
-- ============================================================
-- THE RACE: checkPinRateLimits (app/lib/auth/rateLimit.ts) read the current
-- count BEFORE verification, and incrementPinRateLimit only ran AFTER the
-- outcome was known -- two separate round trips with a window between
-- them. Concurrent requests sharing the SAME scope key (most importantly
-- the ORG scope, which every request in an organization shares regardless
-- of source IP or device) could all read the same not-yet-incremented
-- count in that window and all be admitted to Argon2 verification. This
-- was previously believed to be "bounded, not unlimited" because every
-- request also passes through the separately-atomic ip_all_attempts CPU
-- throttle first -- but that throttle is keyed PER SOURCE IP
-- (deriveRateLimitKey("ip_all_attempts", sourceIp)), so it bounds total
-- compute from ONE IP only. A distributed attacker using N different
-- source IPs (and N different device cookies) gets N independent,
-- unexhausted CPU-throttle budgets -- the org ceiling was NOT bounded by
-- it at all in that scenario. With the org counter at 49/50, 100
-- concurrent wrong-PIN requests from 100 distinct IPs/devices could all
-- read the stale org count of 49, all pass the pre-check, and all reach
-- Argon2 -- overshooting the intended 50-failure ceiling to ~149 with no
-- database-enforced bound.
--
-- THE FIX: collapse "read current count" and "increment on failure" into
-- ONE atomic statement, exactly as increment_pin_rate_limit's
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING already does for the CPU
-- throttle -- but ALSO returning whether the just-incremented count is
-- still within the caller-supplied ceiling, so the caller never needs a
-- separate read at all. Because the increment and the ceiling comparison
-- happen against the SAME value produced by the SAME statement, and
-- Postgres serializes concurrent INSERT ... ON CONFLICT DO UPDATE
-- statements targeting the same row, at most exactly p_max_attempts
-- callers can ever observe out_permitted = true for a given
-- (organization_id, scope, rate_limit_key, window) -- regardless of how
-- many distinct source IPs or devices are used, and regardless of
-- concurrency. This is a NEW, separately-named function (not a change to
-- increment_pin_rate_limit's signature or behavior) specifically so the
-- old 3- and 4-parameter overloads used by the CPU throttle and by any
-- old app instance remain completely untouched.
create function public.register_pin_verification_failure(
  p_organization_id uuid,
  p_scope text,
  p_rate_limit_key text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns table (
  out_attempt_count integer,
  out_permitted boolean
)
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_attempt_count integer;
begin
  if p_scope not in ('device', 'ip', 'org', 'ip_all_attempts') then
    raise exception 'invalid rate limit scope %', p_scope;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.pin_verify_rate_limits (organization_id, scope, rate_limit_key, window_start, attempt_count)
  values (p_organization_id, p_scope, p_rate_limit_key, v_window_start, 1)
  on conflict (organization_id, rate_limit_key, window_start)
    do update set attempt_count = public.pin_verify_rate_limits.attempt_count + 1,
                  scope = excluded.scope
  returning attempt_count into v_attempt_count;

  return query select v_attempt_count, (v_attempt_count <= p_max_attempts);
end;
$$;

revoke all on function public.register_pin_verification_failure(uuid, text, text, integer, integer) from public;
grant execute on function public.register_pin_verification_failure(uuid, text, text, integer, integer) to service_role;

-- ============================================================
-- 6. Manager/admin operational recovery: org-wide kiosk PIN lockout
--    status + unlock.
-- ============================================================
-- A distributed attack (or an organization's own layered scopes all
-- tripping during ordinary heavy use) can leave every kiosk in one
-- organization unable to log in until the affected windows naturally
-- expire (up to WINDOW_SECONDS_ORG = 1 hour for the org scope). These two
-- functions give a Manager/Admin a safe, audited way to see that state and
-- clear it without ever touching employee PIN/hash/kiosk-token data.
--
-- get_org_pin_rate_limit_status is read-only (stable, no writes) and
-- reports only the ORG scope's current-window count/lockout state/expiry
-- -- never raw IPs, device identifiers, or per-scope key material, since
-- the caller supplies an already-derived rate_limit_key exactly the way
-- every other caller in this file does (deriveRateLimitKey is a plain,
-- unkeyed SHA-256 hash, not a secret -- computing it in the manager's own
-- server action is equivalent to computing it here, and keeps this
-- function's signature identical in shape to the others in this file).
create function public.get_org_pin_rate_limit_status(
  p_organization_id uuid,
  p_rate_limit_key text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns table (
  out_attempt_count integer,
  out_is_locked_out boolean,
  out_window_expires_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_attempt_count integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  select attempt_count into v_attempt_count
    from public.pin_verify_rate_limits
   where organization_id = p_organization_id
     and scope = 'org'
     and rate_limit_key = p_rate_limit_key
     and window_start = v_window_start;

  v_attempt_count := coalesce(v_attempt_count, 0);

  return query select
    v_attempt_count,
    v_attempt_count >= p_max_attempts,
    v_window_start + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on function public.get_org_pin_rate_limit_status(uuid, text, integer, integer) from public;
grant execute on function public.get_org_pin_rate_limit_status(uuid, text, integer, integer) to service_role;

-- unlock_org_pin_rate_limits clears EVERY pin_verify_rate_limits row for
-- the caller-supplied organization_id (all four scopes: device/ip/org/
-- ip_all_attempts) -- never any other organization's rows, since the
-- delete is scoped entirely by this one column, and p_organization_id must
-- come from the manager's own trusted server-side session (see
-- app/actions/adminUsers.ts's requireAdmin()), never from client input.
-- This can only ever restore kiosk LOGIN ATTEMPTS -- it does not read,
-- write, or reference app_users.pin_hash/pin_lookup_hash/kiosk tokens at
-- all, so no employee's PIN is affected. security definer (like
-- set_employee_kiosk_pin above) because it performs a privileged,
-- audited, organization-wide write; the audit_events insert uses
-- entity_type = 'organization' (a plain text discriminator, matching this
-- table's existing free-text entity_type convention -- see e.g.
-- 'purchase_document' in 20260811100027) and entity_id = p_organization_id,
-- since audit_events.entity_id is NOT NULL and this action has no
-- per-employee entity to attach to; this is a truthful, non-invented
-- representation of an organization-scoped action, not a schema
-- incompatibility, so no migration change was needed to represent it.
create function public.unlock_org_pin_rate_limits(
  p_organization_id uuid,
  p_actor_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pin_verify_rate_limits
   where organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_actor_app_user_id, 'KIOSK_PIN_RATE_LIMIT_UNLOCK', 'organization', p_organization_id,
    jsonb_build_object('unlockedAt', now())
  );
end;
$$;

revoke all on function public.unlock_org_pin_rate_limits(uuid, uuid) from public;
grant execute on function public.unlock_org_pin_rate_limits(uuid, uuid) to service_role;
