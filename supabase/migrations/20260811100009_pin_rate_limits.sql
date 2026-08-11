-- PIN verification rate limiting
--
-- Approved as a genuine exception to "do not add a table merely because
-- convenient" (docs/DATABASE.md's initial-scope list does not include this):
-- serverless deployment (Vercel) rules out an in-memory rate limiter, and
-- app_users.failed_pin_attempts alone cannot blunt brute-forcing the 6-digit
-- PIN space itself, since a guessed PIN that matches no employee has no
-- app_users row to attach a counter to.
--
-- rate_limit_key is an opaque, server-derived identifier for the request
-- source (e.g. a hash of the source IP), never client-supplied. Scoping by
-- (organization_id, rate_limit_key) rather than organization_id alone is
-- deliberate: it throttles a single misbehaving source without letting that
-- one source lock out every legitimate kiosk in the organization.
--
-- No cleanup/retention policy is implemented here; old windows are left to
-- accrue for V1 and can be pruned by a future maintenance job if needed.

create table public.pin_verify_rate_limits (
  organization_id uuid not null references public.organizations (id),
  rate_limit_key text not null,
  window_start timestamptz not null,
  attempt_count integer not null default 0,
  constraint pin_verify_rate_limits_attempt_count_check check (attempt_count >= 0),
  primary key (organization_id, rate_limit_key, window_start)
);

alter table public.pin_verify_rate_limits enable row level security;
-- Deny-by-default: no policies for anon/authenticated. Accessed only via
-- trusted server-side code using the service_role connection.

-- Atomic check-and-increment for one (organization, source, window). A
-- plain client-side "select then insert/update" would race under
-- concurrent requests from the same source; INSERT ... ON CONFLICT DO
-- UPDATE is a single statement and is race-free regardless of concurrency.
-- Not SECURITY DEFINER: service_role already has the bypassrls attribute in
-- Supabase, so it does not need an elevated-privilege function to write to
-- this RLS-enabled table -- only EXECUTE needs to be restricted to it.
-- search_path is still pinned defensively, consistent with every function
-- in this schema that touches more than trivial logic.
create or replace function public.increment_pin_rate_limit(
  p_organization_id uuid,
  p_rate_limit_key text,
  p_window_seconds integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_attempt_count integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.pin_verify_rate_limits (organization_id, rate_limit_key, window_start, attempt_count)
  values (p_organization_id, p_rate_limit_key, v_window_start, 1)
  on conflict (organization_id, rate_limit_key, window_start)
    do update set attempt_count = public.pin_verify_rate_limits.attempt_count + 1
  returning attempt_count into v_attempt_count;

  return v_attempt_count;
end;
$$;

revoke all on function public.increment_pin_rate_limit(uuid, text, integer) from public;
grant execute on function public.increment_pin_rate_limit(uuid, text, integer) to service_role;
