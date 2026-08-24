-- Canonical Item Master + Inventory Relevance Classification milestone.
--
-- ============================================================
-- WHAT ALREADY EXISTED (verified by direct inspection before writing this
-- migration) -- this migration deliberately does NOT rebuild any of it:
-- ============================================================
-- inventory_items already carries disposition (INVENTORY/NON_INVENTORY),
-- approval_status (PENDING_REVIEW/CONFIRMED), created_via (MANUAL/
-- AI_PROPOSED), and spend_category_id (20260811100035). Classify-then-
-- match, AI candidate proposal, manager approval, vendor-mapping memory
-- (including NON-inventory memory -- a confirmed NON_INVENTORY
-- inventory_items row IS the durable "this vendor code/description means
-- this expense category" record vendor_item_mappings points at), the
-- document-level disposition hint (documents.declared_disposition_hint,
-- 20260811100038), exact-duplicate blocking with a "use existing" error
-- detail (normalize_item_name/GA016, 20260811100060), and posting/
-- completion-gate enforcement that already excludes NON_INVENTORY lines
-- and blocks on any unresolved line (20260811100056/64) are ALL already
-- built and already tested (see completionGate.rpc.test.ts,
-- classificationApprovalGuards.rpc.test.ts, inventoryPosting.rpc.test.ts).
--
-- What genuinely does not exist yet, and is what this migration adds:
--   1. A stable, human-readable Item Number (no prior concept at all).
--   2. Admin-only browse/detail/manual-create/rename/base-unit-change/
--      deactivate-reactivate RPCs for the Item Master -- until now, every
--      inventory_items mutation flowed through the Receiving/classification
--      surface (any Manager), never a dedicated Admin catalog-maintenance
--      surface (Part 7/14/31/56 of the milestone spec: browsing/manually
--      creating/renaming/deactivating Item Master entries is Admin-only;
--      approving a genuinely NEW item encountered in Receiving remains a
--      Manager's job, unchanged).
--   3. A fuzzy "possible duplicate" WARNING (pg_trgm similarity) alongside
--      the existing exact-duplicate BLOCK -- today's normalize_item_name
--      equality check only catches an exact match.
--   4. Admin-only bulk import (a new capability entirely).

create extension if not exists pg_trgm with schema extensions;

-- ============================================================
-- 1. Item Number
-- ============================================================
-- INVENTORY-disposition items only -- a NON_INVENTORY "item" (really a
-- confirmed expense/vendor-mapping target, see the header comment above)
-- is not a Item Master catalog entry and never gets one. Immutable after
-- creation (nothing in this migration or any RPC below ever updates it),
-- never derived from the name (renaming an item never touches it),
-- organization-scoped (each org's numbering starts at ITEM-000001
-- independently, never a cross-tenant global counter).
alter table public.inventory_items
  add column item_number text;

create unique index inventory_items_org_item_number_key
  on public.inventory_items (organization_id, item_number)
  where item_number is not null;

-- Per-organization allocation counter. A dedicated row-locked counter
-- table, not MAX(item_number)+1 (a classic double-allocation race under
-- concurrency) and not a Postgres SEQUENCE (impractical to provision one
-- per organization dynamically). The UPDATE/INSERT below takes a row lock
-- on this org's own counter row, so two concurrent allocations for the
-- SAME org serialize correctly; different orgs never contend with each
-- other at all.
create table public.organization_item_number_counters (
  organization_id uuid primary key references public.organizations (id),
  next_number integer not null default 1
);

alter table public.organization_item_number_counters enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

create or replace function public.allocate_item_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number integer;
begin
  insert into public.organization_item_number_counters (organization_id, next_number)
  values (p_organization_id, 2)
  on conflict (organization_id) do update
    set next_number = public.organization_item_number_counters.next_number + 1
  returning next_number - 1 into v_number;

  return 'ITEM-' || lpad(v_number::text, 6, '0');
end;
$$;

revoke all on function public.allocate_item_number(uuid) from public;
grant execute on function public.allocate_item_number(uuid) to service_role;

-- ============================================================
-- Backfill: existing CONFIRMED INVENTORY items get a stable number now,
-- assigned in created_at order (the closest available proxy for "when
-- this item entered the catalog," never fabricated or reordered by name).
-- Every organization's counter is then advanced to the next free number,
-- so the very next NEW item (via create_admin_item or a fresh Receiving
-- approval) continues the same sequence rather than colliding with a
-- backfilled number.
-- ============================================================
with numbered as (
  select id, organization_id,
         row_number() over (partition by organization_id order by created_at, id) as rn
    from public.inventory_items
   where disposition = 'INVENTORY' and approval_status = 'CONFIRMED' and item_number is null
)
update public.inventory_items ii
   set item_number = 'ITEM-' || lpad(numbered.rn::text, 6, '0')
  from numbered
 where ii.id = numbered.id;

insert into public.organization_item_number_counters (organization_id, next_number)
select organization_id, count(*) + 1
  from public.inventory_items
 where disposition = 'INVENTORY' and approval_status = 'CONFIRMED' and item_number is not null
 group by organization_id
on conflict (organization_id) do update
  set next_number = greatest(public.organization_item_number_counters.next_number, excluded.next_number);

-- ============================================================
-- 2. Fuzzy possible-duplicate search (WARN, distinct from the existing
--    exact-match BLOCK in approve_line_classification_new_item). Read-
--    only, org-scoped, CONFIRMED INVENTORY items only. Used by both the
--    Admin manual Add Item form and Bulk Import preview -- never by AI,
--    which must never auto-dismiss a duplicate warning (Part 15).
-- ============================================================
create or replace function public.find_similar_active_items(
  p_organization_id uuid,
  p_name text,
  p_exclude_item_id uuid default null
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_name text,
  out_base_unit_code text,
  out_similarity real,
  out_is_exact boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ic.name, u.code,
         extensions.similarity(public.normalize_item_name(ii.name), public.normalize_item_name(p_name)),
         public.normalize_item_name(ii.name) = public.normalize_item_name(p_name)
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
   where ii.organization_id = p_organization_id
     and ii.disposition = 'INVENTORY'
     and ii.approval_status = 'CONFIRMED'
     and ii.status = 'active'
     and ii.id is distinct from p_exclude_item_id
     and (
       public.normalize_item_name(ii.name) = public.normalize_item_name(p_name)
       or extensions.similarity(public.normalize_item_name(ii.name), public.normalize_item_name(p_name)) > 0.35
     )
   order by (public.normalize_item_name(ii.name) = public.normalize_item_name(p_name)) desc,
            extensions.similarity(public.normalize_item_name(ii.name), public.normalize_item_name(p_name)) desc
   limit 10;
$$;

revoke all on function public.find_similar_active_items(uuid, text, uuid) from public;
grant execute on function public.find_similar_active_items(uuid, text, uuid) to service_role;

-- ============================================================
-- 3. Admin app-defined SQLSTATEs, continuing the project-wide GA0xx
--    sequence (highest in use before this migration: GA046). Reuses the
--    EXISTING GA016 (public.normalize_item_name / DUPLICATE_ITEM_NAME,
--    20260811100060) for the exact-duplicate case rather than minting a
--    second code for the identical condition -- one Postgres errcode
--    means one thing everywhere in this schema.
-- ============================================================
-- GA047 INVALID_CATEGORY, GA048 INVALID_BASE_UNIT,
-- GA049 BASE_UNIT_CHANGE_BLOCKED_HISTORY, GA050 ITEM_HAS_POSITIVE_STOCK,
-- GA051 ITEM_NOT_FOUND

-- ============================================================
-- 4. list_admin_items / get_admin_item -- Admin Item Master browse/detail.
--    INVENTORY-disposition, CONFIRMED-only: the catalog Admin manages,
--    never a NON_INVENTORY expense-classification row, never an
--    in-flight AI proposal still awaiting a Manager's Receiving review.
-- ============================================================
create or replace function public.list_admin_items(
  p_organization_id uuid,
  p_search text default null,
  p_category_id uuid default null,
  p_base_unit_code text default null,
  p_status text default null
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_name text,
  out_base_unit_code text,
  out_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ic.name, u.code, ii.status
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
   where ii.organization_id = p_organization_id
     and ii.disposition = 'INVENTORY'
     and ii.approval_status = 'CONFIRMED'
     and (p_search is null or btrim(p_search) = '' or ii.name ilike '%' || p_search || '%' or ii.item_number ilike '%' || p_search || '%')
     and (p_category_id is null or ii.category_id = p_category_id)
     and (p_base_unit_code is null or u.code = p_base_unit_code)
     and (p_status is null or ii.status = p_status)
   order by ii.name;
$$;

revoke all on function public.list_admin_items(uuid, text, uuid, text, text) from public;
grant execute on function public.list_admin_items(uuid, text, uuid, text, text) to service_role;

create or replace function public.get_admin_item(
  p_organization_id uuid,
  p_item_id uuid
)
returns table (
  out_item_id uuid,
  out_item_number text,
  out_name text,
  out_category_id uuid,
  out_category_name text,
  out_base_unit_id uuid,
  out_base_unit_code text,
  out_status text,
  out_created_at timestamptz,
  out_updated_at timestamptz,
  out_has_movement_history boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select ii.id, ii.item_number, ii.name, ii.category_id, ic.name, ii.base_unit_id, u.code, ii.status,
         ii.created_at, ii.updated_at,
         exists (select 1 from public.inventory_movement_lines ml where ml.inventory_item_id = ii.id)
    from public.inventory_items ii
    left join public.inventory_categories ic on ic.id = ii.category_id
    left join public.units u on u.id = ii.base_unit_id
   where ii.organization_id = p_organization_id
     and ii.id = p_item_id
     and ii.disposition = 'INVENTORY'
     and ii.approval_status = 'CONFIRMED';
$$;

revoke all on function public.get_admin_item(uuid, uuid) from public;
grant execute on function public.get_admin_item(uuid, uuid) to service_role;

-- ============================================================
-- 5. create_admin_item -- Admin-only manual Add Item (Part 14). Always
--    INVENTORY/CONFIRMED/MANUAL. Item Number is always server-generated
--    -- there is no parameter for the caller to supply one (Part 9: "do
--    not let users casually type arbitrary item numbers").
-- ============================================================
create or replace function public.create_admin_item(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_name text,
  p_category_id uuid,
  p_base_unit_id uuid
)
returns table (
  out_item_id uuid,
  out_item_number text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_duplicate record;
  v_item_id uuid;
  v_item_number text;
begin
  if v_name = '' then
    raise exception 'canonical name is required';
  end if;

  if not exists (select 1 from public.inventory_categories where id = p_category_id and organization_id = p_organization_id and is_active) then
    raise exception 'inventory category % not found or inactive in organization %', p_category_id, p_organization_id using errcode = 'GA047';
  end if;

  if not exists (select 1 from public.units where id = p_base_unit_id) then
    raise exception 'unit % not found', p_base_unit_id using errcode = 'GA048';
  end if;

  select id, name into v_duplicate
    from public.inventory_items
   where organization_id = p_organization_id
     and status = 'active'
     and approval_status = 'CONFIRMED'
     and public.normalize_item_name(name) = public.normalize_item_name(v_name);

  if found then
    raise exception 'an active item named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA016', detail = jsonb_build_object('existingItemId', v_duplicate.id, 'existingItemName', v_duplicate.name)::text;
  end if;

  v_item_id := gen_random_uuid();
  v_item_number := public.allocate_item_number(p_organization_id);

  insert into public.inventory_items (
    id, organization_id, category_id, name, base_unit_id, status,
    disposition, approval_status, created_via, item_number
  ) values (
    v_item_id, p_organization_id, p_category_id, v_name, p_base_unit_id, 'active',
    'INVENTORY', 'CONFIRMED', 'MANUAL', v_item_number
  );

  insert into public.inventory_item_units (
    inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
  ) values (
    v_item_id, p_base_unit_id, 1, false, true, true
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'CANONICAL_ITEM_CREATED', 'inventory_item', v_item_id,
    jsonb_build_object('itemNumber', v_item_number, 'name', v_name));

  return query select v_item_id, v_item_number;
end;
$$;

revoke all on function public.create_admin_item(uuid, uuid, text, uuid, uuid) from public;
grant execute on function public.create_admin_item(uuid, uuid, text, uuid, uuid) to service_role;

-- ============================================================
-- 6. update_admin_item_details -- rename + category change (Part 45/46).
--    Item Number and id are never touched.
-- ============================================================
create or replace function public.update_admin_item_details(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_item_id uuid,
  p_name text,
  p_category_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_current record;
  v_duplicate record;
begin
  if v_name = '' then
    raise exception 'canonical name is required';
  end if;

  select name, category_id into v_current
    from public.inventory_items
   where id = p_item_id and organization_id = p_organization_id and disposition = 'INVENTORY' and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % not found in organization %', p_item_id, p_organization_id using errcode = 'GA051';
  end if;

  if not exists (select 1 from public.inventory_categories where id = p_category_id and organization_id = p_organization_id and is_active) then
    raise exception 'inventory category % not found or inactive in organization %', p_category_id, p_organization_id using errcode = 'GA047';
  end if;

  select id, name into v_duplicate
    from public.inventory_items
   where organization_id = p_organization_id
     and status = 'active'
     and approval_status = 'CONFIRMED'
     and public.normalize_item_name(name) = public.normalize_item_name(v_name)
     and id is distinct from p_item_id;

  if found then
    raise exception 'an active item named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA016', detail = jsonb_build_object('existingItemId', v_duplicate.id, 'existingItemName', v_duplicate.name)::text;
  end if;

  update public.inventory_items
     set name = v_name, category_id = p_category_id
   where id = p_item_id and organization_id = p_organization_id;

  if v_current.name is distinct from v_name then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_actor_app_user_id, 'CANONICAL_ITEM_RENAMED', 'inventory_item', p_item_id,
      jsonb_build_object('name', v_current.name), jsonb_build_object('name', v_name));
  end if;

  if v_current.category_id is distinct from p_category_id then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_actor_app_user_id, 'CANONICAL_ITEM_UPDATED', 'inventory_item', p_item_id,
      jsonb_build_object('categoryId', v_current.category_id), jsonb_build_object('categoryId', p_category_id));
  end if;
end;
$$;

revoke all on function public.update_admin_item_details(uuid, uuid, uuid, text, uuid) from public;
grant execute on function public.update_admin_item_details(uuid, uuid, uuid, text, uuid) to service_role;

-- ============================================================
-- 7. set_admin_item_base_unit -- guarded (Part 45): if this item already
--    has ANY inventory_movement_lines, changing its base unit could
--    silently corrupt historical quantities (every posted movement's
--    normalized_base_quantity is denominated in the unit that was
--    current at posting time) -- BLOCKED outright, no automatic
--    historical conversion is ever attempted.
-- ============================================================
create or replace function public.set_admin_item_base_unit(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_item_id uuid,
  p_base_unit_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_unit_id uuid;
begin
  select base_unit_id into v_current_unit_id
    from public.inventory_items
   where id = p_item_id and organization_id = p_organization_id and disposition = 'INVENTORY' and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % not found in organization %', p_item_id, p_organization_id using errcode = 'GA051';
  end if;

  if v_current_unit_id = p_base_unit_id then
    return; -- no-op
  end if;

  if not exists (select 1 from public.units where id = p_base_unit_id) then
    raise exception 'unit % not found', p_base_unit_id using errcode = 'GA048';
  end if;

  if exists (select 1 from public.inventory_movement_lines where inventory_item_id = p_item_id) then
    raise exception 'base unit cannot be changed because this item already has inventory history' using errcode = 'GA049';
  end if;

  update public.inventory_items set base_unit_id = p_base_unit_id where id = p_item_id and organization_id = p_organization_id;

  update public.inventory_item_units
     set is_default_entry_unit = false
   where inventory_item_id = p_item_id and is_default_entry_unit;

  insert into public.inventory_item_units (inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active)
  values (p_item_id, p_base_unit_id, 1, false, true, true)
  on conflict (inventory_item_id, unit_id) do update set conversion_factor = 1, requires_actual_measurement = false, is_default_entry_unit = true, is_active = true;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_actor_app_user_id, 'CANONICAL_ITEM_UPDATED', 'inventory_item', p_item_id,
    jsonb_build_object('baseUnitId', v_current_unit_id), jsonb_build_object('baseUnitId', p_base_unit_id));
end;
$$;

revoke all on function public.set_admin_item_base_unit(uuid, uuid, uuid, uuid) from public;
grant execute on function public.set_admin_item_base_unit(uuid, uuid, uuid, uuid) to service_role;

-- ============================================================
-- 8. set_admin_item_status -- deactivate/reactivate (Part 47/48). No hard
--    delete anywhere. Deactivation BLOCKED while positive stock remains
--    at any location (reuses the existing inventory_location_balances
--    read model, never a parallel balance calculation).
-- ============================================================
create or replace function public.set_admin_item_status(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_item_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_status text;
  v_positive_stock boolean;
begin
  if p_status not in ('active', 'inactive') then
    raise exception 'invalid item status %', p_status;
  end if;

  select status into v_current_status
    from public.inventory_items
   where id = p_item_id and organization_id = p_organization_id and disposition = 'INVENTORY' and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % not found in organization %', p_item_id, p_organization_id using errcode = 'GA051';
  end if;

  if v_current_status = p_status then
    return; -- no-op
  end if;

  if p_status = 'inactive' then
    select exists (
      select 1 from public.inventory_location_balances(p_organization_id) b
       where b.out_inventory_item_id = p_item_id and b.out_balance > 0
    ) into v_positive_stock;

    if v_positive_stock then
      raise exception 'this item cannot be deactivated while inventory remains in stock -- resolve current inventory first' using errcode = 'GA050';
    end if;
  end if;

  update public.inventory_items set status = p_status where id = p_item_id and organization_id = p_organization_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (
    p_organization_id, p_actor_app_user_id,
    case when p_status = 'inactive' then 'CANONICAL_ITEM_DEACTIVATED' else 'CANONICAL_ITEM_REACTIVATED' end,
    'inventory_item', p_item_id, jsonb_build_object('status', v_current_status), jsonb_build_object('status', p_status)
  );
end;
$$;

revoke all on function public.set_admin_item_status(uuid, uuid, uuid, text) from public;
grant execute on function public.set_admin_item_status(uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 9. Bulk import (Admin-only, Part 16-20/68/80). Durable summary table +
--    row-independent import RPC: one invalid/duplicate row never fails
--    the whole batch (Part 20) -- each row is validated and inserted (or
--    rejected) inside its OWN sub-transaction (a PL/pgSQL EXCEPTION
--    block acts as an implicit SAVEPOINT), so one row's error can never
--    roll back another row's successful insert.
-- ============================================================
create table public.canonical_item_bulk_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  actor_app_user_id uuid not null,
  filename text,
  rows_parsed integer not null,
  rows_imported integer not null,
  rows_rejected integer not null,
  rows_duplicate_skipped integer not null,
  created_at timestamptz not null default now(),
  constraint canonical_item_bulk_imports_actor_org_fk foreign key (actor_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

create index canonical_item_bulk_imports_org_idx
  on public.canonical_item_bulk_imports (organization_id, created_at desc);

create trigger canonical_item_bulk_imports_forbid_update
  before update on public.canonical_item_bulk_imports
  for each row execute function public.forbid_update_delete();
create trigger canonical_item_bulk_imports_forbid_delete
  before delete on public.canonical_item_bulk_imports
  for each row execute function public.forbid_update_delete();

alter table public.canonical_item_bulk_imports enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

-- p_rows: jsonb array of { rowIndex, itemNumber, name, categoryId, baseUnitId, status }.
-- Category/unit resolution (name/code -> id) and per-row structural
-- validation happen in the TypeScript layer BEFORE this RPC is ever
-- called (Part 19: required name, valid category, valid unit, malformed
-- rows) -- this RPC re-validates the things that can only be safely
-- checked with a live, lockable view of the database (duplicate item
-- number, duplicate canonical name, concurrent import safety), never
-- trusting the client-side preview as the final guarantee (Part 80).
create or replace function public.bulk_import_admin_items(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_filename text,
  p_rows jsonb
)
returns table (
  out_row_index integer,
  out_outcome text,
  out_item_id uuid,
  out_item_number text,
  out_message text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_row_index integer;
  v_name text;
  v_category_id uuid;
  v_base_unit_id uuid;
  v_supplied_number text;
  v_status text;
  v_item_id uuid;
  v_item_number text;
  v_duplicate record;
  v_imported integer := 0;
  v_rejected integer := 0;
  v_dup_skipped integer := 0;
begin
  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_row_index := (v_row ->> 'rowIndex')::integer;
    v_name := btrim(coalesce(v_row ->> 'name', ''));
    v_category_id := nullif(v_row ->> 'categoryId', '')::uuid;
    v_base_unit_id := nullif(v_row ->> 'baseUnitId', '')::uuid;
    v_supplied_number := nullif(btrim(coalesce(v_row ->> 'itemNumber', '')), '');
    v_status := coalesce(nullif(v_row ->> 'status', ''), 'active');

    begin
      if v_name = '' then
        raise exception 'canonical name is required';
      end if;
      if v_status not in ('active', 'inactive') then
        raise exception 'invalid status %', v_status;
      end if;
      if not exists (select 1 from public.inventory_categories where id = v_category_id and organization_id = p_organization_id and is_active) then
        raise exception 'category not found or inactive';
      end if;
      if not exists (select 1 from public.units where id = v_base_unit_id) then
        raise exception 'unit not found';
      end if;
      if v_supplied_number is not null and exists (
        select 1 from public.inventory_items where organization_id = p_organization_id and item_number = v_supplied_number
      ) then
        raise exception 'item number % is already in use', v_supplied_number;
      end if;

      select id, name into v_duplicate
        from public.inventory_items
       where organization_id = p_organization_id
         and status = 'active'
         and approval_status = 'CONFIRMED'
         and public.normalize_item_name(name) = public.normalize_item_name(v_name);

      if found then
        out_row_index := v_row_index;
        out_outcome := 'DUPLICATE_SKIPPED';
        out_item_id := v_duplicate.id;
        out_item_number := null;
        out_message := 'an active item named "' || v_duplicate.name || '" already exists';
        v_dup_skipped := v_dup_skipped + 1;
        return next;
        continue;
      end if;

      v_item_id := gen_random_uuid();
      v_item_number := coalesce(v_supplied_number, public.allocate_item_number(p_organization_id));

      insert into public.inventory_items (
        id, organization_id, category_id, name, base_unit_id, status,
        disposition, approval_status, created_via, item_number
      ) values (
        v_item_id, p_organization_id, v_category_id, v_name, v_base_unit_id, v_status,
        'INVENTORY', 'CONFIRMED', 'MANUAL', v_item_number
      );

      insert into public.inventory_item_units (
        inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
      ) values (
        v_item_id, v_base_unit_id, 1, false, true, true
      );

      out_row_index := v_row_index;
      out_outcome := 'IMPORTED';
      out_item_id := v_item_id;
      out_item_number := v_item_number;
      out_message := null;
      v_imported := v_imported + 1;
      return next;
    exception when others then
      out_row_index := v_row_index;
      out_outcome := 'REJECTED';
      out_item_id := null;
      out_item_number := null;
      out_message := sqlerrm;
      v_rejected := v_rejected + 1;
      return next;
    end;
  end loop;

  insert into public.canonical_item_bulk_imports (
    organization_id, actor_app_user_id, filename, rows_parsed, rows_imported, rows_rejected, rows_duplicate_skipped
  ) values (
    p_organization_id, p_actor_app_user_id, p_filename, jsonb_array_length(coalesce(p_rows, '[]'::jsonb)), v_imported, v_rejected, v_dup_skipped
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_actor_app_user_id, 'CANONICAL_ITEM_BULK_IMPORTED', 'canonical_item_bulk_import', gen_random_uuid(),
    jsonb_build_object('filename', p_filename, 'rowsParsed', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)), 'rowsImported', v_imported, 'rowsRejected', v_rejected, 'rowsDuplicateSkipped', v_dup_skipped));

  return;
end;
$$;

revoke all on function public.bulk_import_admin_items(uuid, uuid, text, jsonb) from public;
grant execute on function public.bulk_import_admin_items(uuid, uuid, text, jsonb) to service_role;
