-- Database foundation: inventory transactions
--
-- movement_type is intentionally restricted to only the type this schema and
-- the Milestone 1 workflow actually support: ISSUE_TO_STATION. Every other
-- documented movement type (PURCHASE_RECEIPT, STATION_TRANSFER,
-- RETURN_TO_CENTRAL, WASTE, COUNT_ADJUSTMENT, BATCH_INPUT, BATCH_OUTPUT,
-- VENDOR_RETURN, LEGACY_IMPORT) will be added by a future migration that
-- also adds whatever fields that type needs to be represented correctly
-- (e.g. STATION_TRANSFER needs a destination station this table doesn't
-- have yet). Do not widen this CHECK constraint without adding the
-- corresponding fields.
--
-- Posted movements and their lines are historical, authoritative records:
-- a BEFORE UPDATE/DELETE trigger makes them append-only at the database
-- level (not just by convention), matching the same guarantee audit_events
-- gets. Corrections to a posted withdrawal are out of scope here; they will
-- be modeled as a future offsetting/reversal transaction, not a silent edit.

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  station_id uuid,
  movement_type text not null,
  performed_by_app_user_id uuid,
  business_date date not null,
  occurred_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  constraint inventory_movements_movement_type_check
    check (movement_type in ('ISSUE_TO_STATION')),
  -- a movement's location must belong to the same organization
  constraint inventory_movements_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  -- a movement's station (when present) must belong to the movement's location
  constraint inventory_movements_station_location_fk foreign key (station_id, location_id)
    references public.stations (id, location_id),
  -- the acting employee (when present) must belong to the same organization
  constraint inventory_movements_performed_by_org_fk foreign key (performed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_movements_issue_requires_station_check
    check (movement_type <> 'ISSUE_TO_STATION' or station_id is not null),
  constraint inventory_movements_issue_requires_actor_check
    check (movement_type <> 'ISSUE_TO_STATION' or performed_by_app_user_id is not null),
  -- composite-FK target for inventory_movement_lines/exceptions below
  constraint inventory_movements_id_org_key unique (id, organization_id)
);

create table public.inventory_movement_lines (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references public.inventory_movements (id) on delete restrict,
  organization_id uuid not null,
  inventory_item_id uuid not null,
  entered_quantity numeric not null,
  entered_unit_id uuid not null,
  measured_base_quantity numeric,
  base_unit_id uuid not null references public.units (id),
  normalized_base_quantity numeric not null,
  created_at timestamptz not null default now(),
  constraint inventory_movement_lines_entered_quantity_check check (entered_quantity > 0),
  constraint inventory_movement_lines_measured_qty_check
    check (measured_base_quantity is null or measured_base_quantity > 0),
  constraint inventory_movement_lines_normalized_qty_check check (normalized_base_quantity > 0),
  -- guarantees entered_unit_id is an allowed unit for inventory_item_id
  -- (and transitively that inventory_item_id itself exists, since
  -- inventory_item_units.inventory_item_id already references inventory_items)
  constraint inventory_movement_lines_item_unit_fk foreign key (inventory_item_id, entered_unit_id)
    references public.inventory_item_units (inventory_item_id, unit_id),
  -- organization_id is server-derived from the parent movement (see the
  -- measurement trigger below) and must match both the parent movement's
  -- organization and the referenced item's organization -- this is what
  -- makes a cross-organization movement/item pairing impossible
  constraint inventory_movement_lines_movement_org_fk foreign key (movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint inventory_movement_lines_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  -- composite-FK target for exceptions.source_movement_line_id below
  constraint inventory_movement_lines_id_movement_key unique (id, movement_id)
);

-- Looks up the entered unit's measurement rule for the item, rejects the
-- insert if the rule is violated, and computes organization_id and
-- normalized_base_quantity server-side (never trusted from client input).
--
-- requires_actual_measurement is a hard either/or, not a preference: when
-- true, measured_base_quantity is mandatory and IS the normalized quantity;
-- when false, measured_base_quantity must be absent and
-- normalized_base_quantity is always entered_quantity * conversion_factor.
-- A client can never bypass a fixed conversion by supplying
-- measured_base_quantity on a unit that doesn't call for one.
create or replace function public.enforce_movement_line_measurement()
returns trigger
language plpgsql
as $$
declare
  v_conversion_factor numeric;
  v_requires_measurement boolean;
  v_base_unit_id uuid;
  v_movement_org_id uuid;
begin
  select organization_id into v_movement_org_id
    from public.inventory_movements
   where id = new.movement_id;

  if not found then
    raise exception 'movement_id % does not exist', new.movement_id;
  end if;

  new.organization_id := v_movement_org_id;

  select requires_actual_measurement, conversion_factor
    into v_requires_measurement, v_conversion_factor
    from public.inventory_item_units
   where inventory_item_id = new.inventory_item_id
     and unit_id = new.entered_unit_id
     and is_active;

  if not found then
    raise exception 'entered_unit_id % is not an allowed active unit for inventory_item_id %',
      new.entered_unit_id, new.inventory_item_id;
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = new.inventory_item_id;

  new.base_unit_id := v_base_unit_id;

  if v_requires_measurement then
    if new.measured_base_quantity is null then
      raise exception 'inventory_item_id % requires an actual measured quantity when entered in unit %',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    new.normalized_base_quantity := new.measured_base_quantity;
  else
    if new.measured_base_quantity is not null then
      raise exception 'inventory_item_id % has a fixed conversion for unit % and must not supply measured_base_quantity',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    if v_conversion_factor is null then
      raise exception 'inventory_item_id % has no conversion_factor defined for unit %',
        new.inventory_item_id, new.entered_unit_id;
    end if;
    new.normalized_base_quantity := new.entered_quantity * v_conversion_factor;
  end if;

  return new;
end;
$$;

create trigger inventory_movement_lines_enforce_measurement
  before insert on public.inventory_movement_lines
  for each row execute function public.enforce_movement_line_measurement();

-- Shared append-only guard, reused by audit_events in the next migration.
-- Fires for every role including service_role (unlike RLS, which
-- service_role bypasses by design), so this guarantee holds even against a
-- trusted server connection making a coding mistake.
create or replace function public.forbid_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is an append-only historical table; % is not permitted', tg_table_name, tg_op;
end;
$$;

create trigger inventory_movements_forbid_update
  before update on public.inventory_movements
  for each row execute function public.forbid_update_delete();

create trigger inventory_movements_forbid_delete
  before delete on public.inventory_movements
  for each row execute function public.forbid_update_delete();

create trigger inventory_movement_lines_forbid_update
  before update on public.inventory_movement_lines
  for each row execute function public.forbid_update_delete();

create trigger inventory_movement_lines_forbid_delete
  before delete on public.inventory_movement_lines
  for each row execute function public.forbid_update_delete();

alter table public.inventory_movements enable row level security;
alter table public.inventory_movement_lines enable row level security;
-- Deny-by-default: no policies for anon/authenticated. The withdrawal write
-- path is a future SECURITY DEFINER RPC callable only by trusted
-- server-side code (see the approved plan, section 7) -- not created here.
