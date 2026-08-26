-- Purchase-versus-usage unit model (Milestone: item units).
--
-- Two relationships that were previously conflated onto ONE per-item row
-- in inventory_item_units are now made explicit:
--
--   1. inventory_item_usage_units -- which of an item's inventory_item_units
--      rows the KIOSK may accept as a withdrawal unit (at most one primary,
--      one optional secondary). This is a NEW, separate concept: an item's
--      base-unit row and its purchase-unit row already exist in
--      inventory_item_units and are UNCHANGED by this migration; this table
--      only says "these specific rows are kiosk-authorized," never "this
--      row conceptually IS a purchase or usage unit" (that framing was
--      rejected during design -- role tagging conflates two independent
--      relationships that must be able to disagree, e.g. the same global
--      unit code meaning a different quantity for a vendor than for the
--      kiosk).
--
--   2. vendor_item_purchase_units -- a vendor/SKU-specific purchase-package
--      configuration, attached to the STABLE vendor_item_mappings identity
--      (one row per confirmed vendor-SKU-to-item mapping), never to the
--      bare (item, unit code) pair inventory_item_units used for purchase
--      packaging today. This is what makes "Vendor A: 1 CASE = 24 bottles"
--      and "Vendor B: 1 CASE = 12 bottles" for the SAME canonical item
--      possible without one overwriting the other -- the previous design's
--      inventory_item_units_item_unit_key unique(inventory_item_id, unit_id)
--      structurally could not.
--
-- Both tables are purely additive. inventory_item_units keeps its existing
-- role as the authoritative store of "this (item, unit) pair converts to
-- the base unit via this factor, or requires actual measurement" -- for
-- BOTH kiosk usage rows and (for now) the item's own base-unit row.
-- Historical inventory_movement_lines/purchase_document_inventory_posting_lines
-- rows reference inventory_item_units exactly as before and are completely
-- unaffected: neither new table is referenced FROM any historical record,
-- so deactivating a usage slot or superseding a vendor package can never
-- reinterpret a posted/withdrawn quantity.

-- ============================================================
-- 1. Composite-FK targets on existing tables (additive, trivially
--    satisfiable -- id is already each table's primary key, so a unique
--    constraint on (id, <other column>) can never find a duplicate).
-- ============================================================
alter table public.inventory_item_units
  add constraint inventory_item_units_id_item_key unique (id, inventory_item_id);

alter table public.vendor_item_mappings
  add constraint vendor_item_mappings_id_vendor_item_org_key unique (id, vendor_id, inventory_item_id, organization_id);

-- ============================================================
-- 2. inventory_item_usage_units -- kiosk usage-slot authorization
-- ============================================================
-- confirmed_by_app_user_id/confirmed_at are nullable ONLY to allow the
-- backfill below (section 4) to represent pre-existing base-unit
-- configuration honestly, as "migrated, never explicitly re-confirmed by
-- a manager under this model" -- never fabricating a confirming actor.
-- Every row written by the NEW approval RPCs (a later migration) always
-- supplies a real app_user_id; this column being nullable at the schema
-- level does not weaken that going forward.
create table public.inventory_item_usage_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  inventory_item_id uuid not null,
  inventory_item_unit_id uuid not null,
  usage_slot smallint not null,
  is_active boolean not null default true,
  confirmed_by_app_user_id uuid,
  confirmed_at timestamptz,
  -- Set when this slot is deactivated in favor of a replacement (e.g. a
  -- manager swaps the secondary unit) -- history/audit only, never used
  -- to reinterpret an already-recorded movement.
  superseded_by_usage_unit_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inventory_item_usage_units_slot_check check (usage_slot in (1, 2)),
  constraint inventory_item_usage_units_confirmed_pair_check check (
    (confirmed_by_app_user_id is null) = (confirmed_at is null)
  ),
  constraint inventory_item_usage_units_not_self_superseded check (superseded_by_usage_unit_id is distinct from id),
  constraint inventory_item_usage_units_id_org_key unique (id, organization_id),
  constraint inventory_item_usage_units_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_item_usage_units_confirmed_by_org_fk foreign key (confirmed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- Proves the referenced inventory_item_units row genuinely belongs to
  -- THIS item -- never trusted from the caller alone.
  constraint inventory_item_usage_units_conversion_item_fk foreign key (inventory_item_unit_id, inventory_item_id)
    references public.inventory_item_units (id, inventory_item_id),
  constraint inventory_item_usage_units_superseded_org_fk foreign key (superseded_by_usage_unit_id, organization_id)
    references public.inventory_item_usage_units (id, organization_id)
);

-- Concurrency-safe: PostgreSQL enforces a partial unique index atomically
-- at the statement/commit level regardless of concurrent transactions --
-- two simultaneous inserts both claiming slot 1 for the same item can
-- never both succeed, unlike a count-only trigger (which reads a count,
-- then decides, then inserts -- a classic TOCTOU race under concurrent
-- transactions at read-committed isolation).
create unique index inventory_item_usage_units_active_slot_key
  on public.inventory_item_usage_units (organization_id, inventory_item_id, usage_slot)
  where is_active;

-- Concurrency-safe: the same inventory_item_units row can never occupy
-- both active slots for the same item.
create unique index inventory_item_usage_units_active_unit_key
  on public.inventory_item_usage_units (organization_id, inventory_item_id, inventory_item_unit_id)
  where is_active;

create index inventory_item_usage_units_item_idx
  on public.inventory_item_usage_units (organization_id, inventory_item_id);

create trigger inventory_item_usage_units_set_updated_at
  before update on public.inventory_item_usage_units
  for each row execute function public.set_updated_at();

-- Only a FIXED-CONVERSION inventory_item_units row may ever become a
-- kiosk usage unit (Section 3/4: "the kiosk has no way to collect an
-- authoritative actual measurement per withdrawal today"). Enforced by
-- trigger rather than a plain CHECK constraint because the fact being
-- checked (requires_actual_measurement) lives on a DIFFERENT table.
create or replace function public.enforce_usage_unit_fixed_conversion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_requires_measurement boolean;
begin
  select requires_actual_measurement into v_requires_measurement
    from public.inventory_item_units
   where id = new.inventory_item_unit_id;

  if v_requires_measurement then
    raise exception 'inventory_item_unit_id % requires actual measurement and cannot be a kiosk usage unit', new.inventory_item_unit_id
      using errcode = 'GA030';
  end if;

  return new;
end;
$$;

create trigger inventory_item_usage_units_enforce_fixed_conversion
  before insert or update on public.inventory_item_usage_units
  for each row execute function public.enforce_usage_unit_fixed_conversion();

alter table public.inventory_item_usage_units enable row level security;
-- Deny-by-default: no policies for anon/authenticated -- reads/writes only
-- through trusted server-side RPCs and the service-role client, matching
-- every other table in this schema.

-- ============================================================
-- 3. vendor_item_purchase_units -- vendor/SKU-specific purchase packaging
-- ============================================================
create table public.vendor_item_purchase_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  -- The STABLE vendor-SKU identity this package belongs to -- never
  -- vendor_id + inventory_item_id alone, which would collide the moment
  -- one vendor has two SKUs for the same item.
  vendor_item_mapping_id uuid not null,
  -- Denormalized for composite-FK/org-safety convenience only; the FK
  -- below GUARANTEES these can never disagree with the referenced
  -- mapping's own vendor_id/inventory_item_id/organization_id.
  vendor_id uuid not null,
  inventory_item_id uuid not null,
  purchase_unit_id uuid not null references public.units (id),
  receiving_behavior text not null,
  conversion_factor numeric,
  requires_actual_measurement boolean not null default false,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  is_active boolean not null default true,
  confirmed_by_app_user_id uuid not null,
  confirmed_at timestamptz not null default now(),
  superseded_by_purchase_unit_id uuid,
  created_at timestamptz not null default now(),

  constraint vendor_item_purchase_units_receiving_behavior_check
    check (receiving_behavior in ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')),
  constraint vendor_item_purchase_units_conversion_factor_check
    check (conversion_factor is null or conversion_factor > 0),
  -- Same XOR guarantee as inventory_item_units: a trustworthy fixed
  -- conversion, or a demand for real measurement -- never both, never
  -- neither.
  constraint vendor_item_purchase_units_measurement_xor_check check (
    (requires_actual_measurement and conversion_factor is null)
    or (not requires_actual_measurement and conversion_factor is not null)
  ),
  constraint vendor_item_purchase_units_effective_range_check
    check (effective_to is null or effective_to > effective_from),
  constraint vendor_item_purchase_units_not_self_superseded check (superseded_by_purchase_unit_id is distinct from id),
  constraint vendor_item_purchase_units_id_org_key unique (id, organization_id),
  -- Proves vendor_id/inventory_item_id/organization_id can never disagree
  -- with the mapping this package claims to belong to.
  constraint vendor_item_purchase_units_mapping_identity_fk foreign key (vendor_item_mapping_id, vendor_id, inventory_item_id, organization_id)
    references public.vendor_item_mappings (id, vendor_id, inventory_item_id, organization_id),
  constraint vendor_item_purchase_units_confirmed_by_org_fk foreign key (confirmed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint vendor_item_purchase_units_superseded_org_fk foreign key (superseded_by_purchase_unit_id, organization_id)
    references public.vendor_item_purchase_units (id, organization_id)
);

-- At most ONE currently-active purchase-package configuration per vendor
-- SKU (vendor_item_mapping) -- since each distinct SKU already gets its
-- own vendor_item_mappings row (vendor_item_mappings_org_vendor_sku_key),
-- this can never prevent one vendor from having two SKUs, or two vendors
-- from having their own factor for "CASE" -- both cases get their own
-- vendor_item_mapping_id and therefore their own row here. A package-size
-- change is modeled as: deactivate the old row (is_active=false,
-- effective_to=now(), superseded_by_purchase_unit_id=<new>), insert a new
-- active row -- mirroring vendor_item_mappings' own superseded-by pattern
-- exactly, never an in-place UPDATE of a historical factor.
create unique index vendor_item_purchase_units_active_mapping_key
  on public.vendor_item_purchase_units (organization_id, vendor_item_mapping_id)
  where is_active;

create index vendor_item_purchase_units_item_idx
  on public.vendor_item_purchase_units (organization_id, inventory_item_id);

create index vendor_item_purchase_units_mapping_idx
  on public.vendor_item_purchase_units (vendor_item_mapping_id);

alter table public.vendor_item_purchase_units enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- ============================================================
-- 4. Forward-compatible classification link
-- ============================================================
-- Additive, nullable -- existing classification rows (written before this
-- migration) simply have this null, which is never treated as an error;
-- legacy resolved_against_snapshot/inventory_item_id fields remain fully
-- readable and are never reinterpreted.
alter table public.purchase_document_line_classifications
  add column vendor_item_purchase_unit_id uuid;

alter table public.purchase_document_line_classifications
  add constraint purchase_document_line_classifications_vendor_package_org_fk
  foreign key (vendor_item_purchase_unit_id, organization_id)
  references public.vendor_item_purchase_units (id, organization_id);

-- ============================================================
-- 5. Backfill: existing base-unit rows become primary kiosk usage units
-- ============================================================
-- Preserves TODAY's kiosk behavior exactly (every currently-withdrawable
-- item keeps working) without inventing anything: the base-unit row
-- already existed and was already the item's sole withdrawal unit by
-- application convention (app/lib/kiosk/withdrawalUnit.ts) -- this simply
-- makes that convention an explicit, database-authoritative fact.
-- confirmed_by_app_user_id is deliberately left NULL (see the table
-- comment above) -- confirmed_at reuses the item's own real created_at as
-- the best-available honest timestamp, never a fabricated "confirmation."
-- Non-INVENTORY items and PENDING_REVIEW proposals are excluded: neither
-- has (or should have) a usage configuration.
insert into public.inventory_item_usage_units (
  organization_id, inventory_item_id, inventory_item_unit_id, usage_slot, is_active, confirmed_by_app_user_id, confirmed_at
)
select ii.organization_id, ii.id, iiu.id, 1, true, null, ii.created_at
  from public.inventory_items ii
  join public.inventory_item_units iiu
    on iiu.inventory_item_id = ii.id
   and iiu.unit_id = ii.base_unit_id
   and iiu.is_active
   and not iiu.requires_actual_measurement
 where ii.disposition = 'INVENTORY'
   and ii.approval_status = 'CONFIRMED';
