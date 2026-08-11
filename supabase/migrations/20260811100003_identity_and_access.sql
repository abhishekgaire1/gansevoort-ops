-- Database foundation: identity and access
--
-- employees = HR/labor identity. app_users = login/auth identity, 1:1 with
-- employees in V1 (docs/DATABASE.md: "Employee -> App User -> Roles").
-- PINs are never stored in plaintext (CLAUDE.md, AGENTS.md): app_users stores
-- only a peppered HMAC lookup hash (to identify which employee typed a PIN,
-- since the workflow is PIN-first with no separate name-selection step) and
-- an argon2id verification hash. Both are computed in server-side application
-- code, never in the database. PIN uniqueness is scoped per organization,
-- not global. Manager/admin dashboard auth uses Supabase Auth
-- (app_users.auth_user_id, nullable); the shared kiosk uses the PIN workflow.

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  first_name text not null,
  last_name text not null,
  employee_code text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_status_check check (status in ('active', 'inactive', 'terminated')),
  -- composite-FK target for app_users below
  constraint employees_id_org_key unique (id, organization_id)
);

-- employee codes are unique within an organization, not globally, and
-- case-insensitively so "A123" and "a123" can't coexist as distinct codes
create unique index employees_org_lower_employee_code_key
  on public.employees (organization_id, lower(employee_code))
  where employee_code is not null;

-- Shared updated_at guard, reused by every current V1 table that has an
-- updated_at column (inventory_items, control_rules) -- the column's
-- `default now()` only initializes it; without this trigger it would never
-- change again after an UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger employees_set_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null unique references public.employees (id),
  auth_user_id uuid unique references auth.users (id),
  pin_lookup_hash text not null,
  pin_hash text not null,
  pin_set_at timestamptz not null default now(),
  failed_pin_attempts smallint not null default 0,
  locked_until timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- an app_user's organization_id must match its employee's organization_id
  constraint app_users_employee_org_fk foreign key (employee_id, organization_id)
    references public.employees (id, organization_id),
  -- composite-FK target for inventory_movements/control_rules/exceptions later
  constraint app_users_id_org_key unique (id, organization_id),
  -- PINs are unique within an organization, not globally
  constraint app_users_org_pin_lookup_key unique (organization_id, pin_lookup_hash),
  constraint app_users_failed_pin_attempts_check check (failed_pin_attempts >= 0)
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text
);

-- case-insensitive: prevents "Manager" and "manager" coexisting as distinct
-- roles; roles are global, not organization-scoped
create unique index roles_lower_name_key
  on public.roles (lower(name));

create table public.user_roles (
  app_user_id uuid not null,
  role_id uuid not null references public.roles (id),
  organization_id uuid not null,
  granted_at timestamptz not null default now(),
  granted_by_app_user_id uuid,
  primary key (app_user_id, role_id),
  -- organization_id is server-derived from app_user_id (see the trigger
  -- below) and not trusted from client input; the role itself stays global
  constraint user_roles_app_user_org_fk foreign key (app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- the granter (when present) must belong to the same organization as the grantee
  constraint user_roles_granted_by_org_fk foreign key (granted_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

-- Looks up app_user_id's organization and overwrites organization_id with
-- it, so a role grant can never be recorded against an organization other
-- than the one the app_user actually belongs to.
create or replace function public.enforce_user_roles_organization()
returns trigger
language plpgsql
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id
    from public.app_users
   where id = new.app_user_id;

  if not found then
    raise exception 'app_user_id % does not exist', new.app_user_id;
  end if;

  new.organization_id := v_org_id;

  return new;
end;
$$;

create trigger user_roles_enforce_organization
  before insert or update on public.user_roles
  for each row execute function public.enforce_user_roles_organization();

alter table public.employees enable row level security;
alter table public.app_users enable row level security;
alter table public.roles enable row level security;
alter table public.user_roles enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
