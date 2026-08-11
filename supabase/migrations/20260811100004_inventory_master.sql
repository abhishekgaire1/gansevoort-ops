-- Database foundation: inventory master data
--
-- Canonical inventory items only (docs/BUSINESS_RULES.md: "a canonical
-- inventory item must have one internal identity regardless of vendor
-- wording"). No legacy-import/staging mechanism or external-name mapping is
-- introduced in this migration; that is deliberately deferred to a future,
-- dedicated migration so the canonical master stays clean.
--
-- inventory_item_units models measurement requirements per item+unit, not
-- per item: a unit either has a trustworthy fixed conversion_factor into the
-- item's base unit, or it requires an actual measured quantity at entry time
-- -- never both, never neither. This makes "do not invent a nominal fixed
-- box weight for variable-weight meat" a hard database guarantee.

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  is_active boolean not null default true,
  -- composite-FK target for inventory_items below
  constraint inventory_categories_id_org_key unique (id, organization_id)
);

-- case-insensitive: prevents "Produce" and "produce" coexisting as distinct categories
create unique index inventory_categories_org_lower_name_key
  on public.inventory_categories (organization_id, lower(name));

create table public.units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit_type text not null,
  constraint units_unit_type_check check (unit_type in ('COUNT', 'WEIGHT', 'VOLUME'))
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  category_id uuid not null,
  name text not null,
  base_unit_id uuid not null references public.units (id),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_items_status_check check (status in ('active', 'inactive')),
  -- composite-FK target for inventory_movements/control_rules/exceptions later
  constraint inventory_items_id_org_key unique (id, organization_id),
  -- an item's category must belong to the same organization as the item
  constraint inventory_items_category_org_fk foreign key (category_id, organization_id)
    references public.inventory_categories (id, organization_id)
);

-- case-insensitive: prevents "Chicken Breast" and "chicken breast" coexisting
-- as distinct canonical items
create unique index inventory_items_org_lower_name_key
  on public.inventory_items (organization_id, lower(name));

-- reuses the shared updated_at guard defined in the identity_and_access migration
create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

create table public.inventory_item_units (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items (id),
  unit_id uuid not null references public.units (id),
  conversion_factor numeric,
  requires_actual_measurement boolean not null default false,
  is_default_entry_unit boolean not null default false,
  is_active boolean not null default true,
  -- composite-FK target for inventory_movement_lines: guarantees the entered
  -- unit is actually an allowed unit for that item
  constraint inventory_item_units_item_unit_key unique (inventory_item_id, unit_id),
  constraint inventory_item_units_conversion_factor_check
    check (conversion_factor is null or conversion_factor > 0),
  -- a unit has either a trustworthy fixed conversion, or it demands a real
  -- measurement -- never both, never neither
  constraint inventory_item_units_measurement_xor_check check (
    (requires_actual_measurement and conversion_factor is null)
    or (not requires_actual_measurement and conversion_factor is not null)
  )
);

create unique index inventory_item_units_one_default_per_item
  on public.inventory_item_units (inventory_item_id)
  where is_default_entry_unit;

alter table public.inventory_categories enable row level security;
alter table public.units enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_item_units enable row level security;
-- Deny-by-default: no policies for anon/authenticated.
