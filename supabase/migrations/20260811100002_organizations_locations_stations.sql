-- Database foundation: organizations, locations, stations
--
-- Organization -> Location -> Station is the top of the operational hierarchy
-- (docs/DATABASE.md "Important Relationships"). Composite foreign keys enforce
-- that a station cannot claim an organization different from its own
-- location's organization, and are the pattern reused throughout this
-- migration set for hierarchy integrity (docs/ARCHITECTURE.md, "use foreign
-- keys and database constraints where they protect business integrity").

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  timezone text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- composite-FK target for stations below
  constraint locations_id_org_key unique (id, organization_id)
);

-- case-insensitive: prevents "WTC" and "wtc" coexisting as distinct locations
create unique index locations_org_lower_name_key
  on public.locations (organization_id, lower(name));

create table public.stations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null references public.locations (id),
  name text not null,
  code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- composite-FK targets for inventory_movements/control_rules/exceptions later
  constraint stations_id_location_key unique (id, location_id),
  constraint stations_id_org_key unique (id, organization_id),
  -- a station's organization_id must match its location's organization_id
  constraint stations_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
);

-- case-insensitive: prevents "Grill" and "grill" coexisting as distinct
-- stations within the same location
create unique index stations_location_lower_name_key
  on public.stations (location_id, lower(name));

alter table public.organizations enable row level security;
alter table public.locations enable row level security;
alter table public.stations enable row level security;
-- Deny-by-default for V1: no policies are created for anon/authenticated on
-- any table in this migration set. All access (reads and writes) flows
-- browser -> Next.js server -> database via service_role, never a direct
-- client Supabase connection. See docs/ARCHITECTURE.md "Server vs Client".
