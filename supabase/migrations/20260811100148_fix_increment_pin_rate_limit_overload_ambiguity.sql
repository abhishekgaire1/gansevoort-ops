-- Fix: ambiguous increment_pin_rate_limit overload breaking Ask Gansevoort.
--
-- 20260811100118 added a second, scope-aware overload of
-- increment_pin_rate_limit(uuid, text, integer, text default 'ip')
-- alongside the original increment_pin_rate_limit(uuid, text, integer)
-- from 20260811100009, on the documented assumption that PostgREST/
-- Postgres would deterministically resolve a named-parameter call
-- supplying only the original three arguments to the three-parameter
-- overload (exact match, zero defaults needed) rather than the new one
-- (which would need its trailing p_scope defaulted).
--
-- That assumption is empirically wrong. app/lib/ai/chatRateLimit.ts
-- (Ask Gansevoort's rate limiter, which deliberately calls with only the
-- original three named arguments -- see its own header comment) has been
-- failing on every request since 20260811100118 was applied:
--
--   Could not choose the best candidate function between:
--     increment_pin_rate_limit(p_organization_id => uuid,
--       p_rate_limit_key => text, p_window_seconds => integer),
--     increment_pin_rate_limit(p_organization_id => uuid,
--       p_rate_limit_key => text, p_window_seconds => integer,
--       p_scope => text)
--
-- Postgres's overload resolution does not special-case "fewest defaults
-- needed" as a total order the way 20260811100118's comment assumed --
-- with two otherwise-compatible candidates it raises 42725 ambiguous
-- function instead of picking one.
--
-- Fix: rather than removing the ability to call scope-aware, renames
-- that overload to a distinct function name (increment_pin_rate_limit_
-- scoped) so there is exactly ONE increment_pin_rate_limit signature
-- again -- restoring Ask Gansevoort's caller to working, unambiguous
-- dispatch -- and repoints rateLimit.ts's PIN-attempt caller (the only
-- caller that ever supplies p_scope) at the new name. Body is copied
-- verbatim from 20260811100118; no behavior change for PIN rate
-- limiting. increment_pin_rate_limit(uuid, text, integer) itself
-- (20260811100009) is untouched.
drop function if exists public.increment_pin_rate_limit(uuid, text, integer, text);

create function public.increment_pin_rate_limit_scoped(
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

revoke all on function public.increment_pin_rate_limit_scoped(uuid, text, integer, text) from public;
grant execute on function public.increment_pin_rate_limit_scoped(uuid, text, integer, text) to service_role;
