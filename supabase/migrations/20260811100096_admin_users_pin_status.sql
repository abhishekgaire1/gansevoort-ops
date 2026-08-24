-- Identity + Access Management milestone -- list_admin_users/
-- get_admin_user (20260811100094) predate app_users.pin_lookup_hash
-- becoming nullable (20260811100095): an app_user row's existence no
-- longer implies it has a kiosk PIN configured (a Manager/Admin-only
-- app_user has neither). Adds out_has_pin so the Admin Users UI can
-- correctly distinguish "PIN: Configured" from "PIN: Not configured"
-- without ever exposing the PIN itself. CREATE OR REPLACE cannot add an
-- output column, so both are dropped and recreated here.
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
