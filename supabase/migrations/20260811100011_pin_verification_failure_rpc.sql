-- Atomic PIN-verification failure bookkeeping.
--
-- Replaces a former application-side read-then-write (SELECT the row,
-- compute new failed_pin_attempts/locked_until in JS, then UPDATE), which
-- could lose an increment under concurrent wrong-PIN requests against the
-- same app_user: two concurrent requests could both read the same starting
-- failed_pin_attempts and both write back attempts+1, losing one failure.
--
-- A single UPDATE ... SET ... = CASE ... WHERE id = $1 is race-free
-- regardless of concurrency: Postgres takes a row-level lock for the
-- duration of the statement and evaluates every SET expression against one
-- consistent pre-update snapshot of that row; a second concurrent UPDATE to
-- the same row waits for the first to complete and then re-evaluates
-- against the now-updated row, so increments are never lost.
--
-- Implements the exact existing policy as one statement:
--   - currently in an active lockout (locked_until in the future): remains
--     locked, attempts unchanged.
--   - a previous lockout has expired (locked_until in the past): this
--     failure starts a fresh cycle at 1, locked_until reset to null (not an
--     immediate re-lock).
--   - otherwise: increment failed_pin_attempts; once it reaches 5, set
--     locked_until = now() + 5 minutes.
--
-- Successful verification's reset (failed_pin_attempts=0, locked_until=null)
-- is intentionally NOT moved into a function: it's an unconditional set with
-- no dependency on the row's current value, so it is already atomic as a
-- single UPDATE statement on its own -- no read-then-write race exists there
-- to fix. A genuine race between a concurrent success and a concurrent
-- failure against the same app_user is two distinct legitimate outcomes
-- competing for the same row; ordinary last-write-wins semantics apply, the
-- same as any other pair of concurrent UPDATEs to one row, and is not a lost
-- update bug this function (or any single statement) can or should mask.
--
-- Not SECURITY DEFINER, for the same reason as increment_pin_rate_limit():
-- service_role already has bypassrls in Supabase, so no elevated-privilege
-- function is needed to write to this RLS-enabled table -- only EXECUTE
-- needs to be restricted to it.
create or replace function public.register_pin_verification_failure(
  p_app_user_id uuid
)
returns table (
  failed_pin_attempts smallint,
  locked_until timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_failed_pin_attempts smallint;
  v_locked_until timestamptz;
begin
  update public.app_users
     set failed_pin_attempts = case
           when locked_until is not null and locked_until > now() then failed_pin_attempts
           when locked_until is not null and locked_until <= now() then 1
           else failed_pin_attempts + 1
         end,
         locked_until = case
           when locked_until is not null and locked_until > now() then locked_until
           when locked_until is not null and locked_until <= now() then null
           when failed_pin_attempts + 1 >= 5 then now() + interval '5 minutes'
           else locked_until
         end
   where id = p_app_user_id
  returning failed_pin_attempts, locked_until
    into v_failed_pin_attempts, v_locked_until;

  if not found then
    raise exception 'app_user_id % does not exist', p_app_user_id;
  end if;

  return query select v_failed_pin_attempts, v_locked_until;
end;
$$;

revoke all on function public.register_pin_verification_failure(uuid) from public;
grant execute on function public.register_pin_verification_failure(uuid) to service_role;
