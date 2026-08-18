-- Milestone 2A.3 (part 1 of 8): spend_categories + Item Master classification
-- columns.
--
-- spend_categories is org-scoped and hierarchical (parent_id) -- the first
-- self-referencing table in this schema. Two PARTIAL unique indexes (never
-- a single non-partial one) enforce name uniqueness correctly at every
-- depth: a plain unique(organization_id, parent_id, lower(name)) would
-- silently allow duplicate ROOT categories, because SQL treats every NULL
-- parent_id as distinct from every other NULL, so two different rows named
-- "Food" with parent_id=NULL would never collide under a naive constraint.
--
-- inventory_items gains disposition/spend_category_id/approval_status/
-- created_via. category_id and base_unit_id become nullable, guarded by
-- disposition-aware checks: a NON_INVENTORY item (e.g. a real expense that
-- is never tracked as stock) needs neither, confirmed or not -- those
-- concepts don't apply to it. Only a CONFIRMED + INVENTORY item requires
-- both. approval_status tracks ITEM APPROVAL (is this a real, manager-
-- blessed Item Master entry, or an AI proposal still sitting on the row) --
-- deliberately not named "mapping_status", which would be confusable with
-- the separate vendor_item_mappings concept added later in this sequence.

create table public.spend_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  parent_id uuid,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- composite-FK target for parent_id below, and for anything that
  -- references a spend category from another org-scoped table
  constraint spend_categories_id_org_key unique (id, organization_id),
  constraint spend_categories_parent_org_fk foreign key (parent_id, organization_id)
    references public.spend_categories (id, organization_id),
  constraint spend_categories_not_self_parent check (parent_id is distinct from id)
);

-- Root categories (parent_id is null): case-insensitive unique per org.
-- parent_id is NOT part of this index's key -- only organization_id and
-- lower(name) are -- which is exactly what makes it catch true root-level
-- duplicates that a plain (organization_id, parent_id, lower(name)) unique
-- constraint would miss.
create unique index spend_categories_org_root_lower_name_key
  on public.spend_categories (organization_id, lower(name))
  where parent_id is null;

-- Non-root categories: case-insensitive unique among siblings under the
-- same parent.
create unique index spend_categories_org_parent_lower_name_key
  on public.spend_categories (organization_id, parent_id, lower(name))
  where parent_id is not null;

create index spend_categories_org_parent_idx
  on public.spend_categories (organization_id, parent_id);

alter table public.spend_categories enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- Cycle prevention: the first self-referencing table in this schema needs
-- an explicit guard, since nothing structural otherwise prevents a chain
-- from eventually looping back on itself. Walks the parent chain with a
-- bounded hop count (a safety valve against a pathological chain, not a
-- real depth limit -- ordinary org taxonomies are a handful of levels deep
-- at most) and rejects if the row's own id is ever revisited.
create or replace function public.prevent_spend_category_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_current_parent uuid;
  v_hops integer := 0;
begin
  if new.parent_id is null then
    return new;
  end if;

  v_current_parent := new.parent_id;
  while v_current_parent is not null loop
    if v_current_parent = new.id then
      raise exception 'spend_category % cannot be its own ancestor', new.id
        using errcode = 'GA007';
    end if;

    v_hops := v_hops + 1;
    if v_hops > 50 then
      raise exception 'spend_category % parent chain exceeds the maximum supported depth', new.id
        using errcode = 'GA007';
    end if;

    select parent_id into v_current_parent
      from public.spend_categories
     where id = v_current_parent
       and organization_id = new.organization_id;
  end loop;

  return new;
end;
$$;

create trigger spend_categories_prevent_cycle
  before insert or update of parent_id on public.spend_categories
  for each row execute function public.prevent_spend_category_cycle();

-- ============================================================
-- Item Master classification columns
-- ============================================================

alter table public.inventory_items
  add column disposition text not null default 'INVENTORY',
  add column spend_category_id uuid,
  add column approval_status text not null default 'CONFIRMED',
  add column created_via text not null default 'MANUAL';

alter table public.inventory_items
  add constraint inventory_items_disposition_check
  check (disposition in ('INVENTORY', 'NON_INVENTORY'));

alter table public.inventory_items
  add constraint inventory_items_approval_status_check
  check (approval_status in ('PENDING_REVIEW', 'CONFIRMED'));

alter table public.inventory_items
  add constraint inventory_items_created_via_check
  check (created_via in ('MANUAL', 'AI_PROPOSED'));

alter table public.inventory_items
  add constraint inventory_items_spend_category_org_fk foreign key (spend_category_id, organization_id)
    references public.spend_categories (id, organization_id);

-- category_id/base_unit_id become optional -- but only for a
-- PENDING_REVIEW row, or a CONFIRMED row whose disposition is
-- NON_INVENTORY (inventory categorization and a base unit of measure are
-- both meaningless for something never tracked as stock). Every existing
-- (implicitly CONFIRMED, implicitly INVENTORY-shaped) row already has both
-- set, so these defaults/checks change nothing for pre-2A.3 data.
alter table public.inventory_items
  alter column category_id drop not null,
  alter column base_unit_id drop not null;

alter table public.inventory_items
  add constraint inventory_items_category_required_check
  check (approval_status = 'PENDING_REVIEW' or disposition = 'NON_INVENTORY' or category_id is not null);

alter table public.inventory_items
  add constraint inventory_items_base_unit_required_check
  check (approval_status = 'PENDING_REVIEW' or disposition = 'NON_INVENTORY' or base_unit_id is not null);

create index inventory_items_org_approval_status_idx
  on public.inventory_items (organization_id, approval_status);
