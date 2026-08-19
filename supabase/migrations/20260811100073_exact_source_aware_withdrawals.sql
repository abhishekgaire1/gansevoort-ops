-- Milestone 2A.5 -- exact source-aware ISSUE_TO_STATION withdrawals,
-- storage-eligible locations, and a frozen legacy-allocation read model
-- (Phase 2 of the approved 2A.5 design; transfers/waste/cycle-counts are
-- NOT part of this migration).
--
-- ============================================================
-- WHAT inventory_movements.location_id MEANS FROM HERE ON
-- ============================================================
-- Consistently, for every movement type: the PHYSICAL STORAGE LOCATION
-- affected by the movement (PURCHASE_RECEIPT already meant this;
-- ISSUE_TO_STATION did not -- it was hard-derived from the station's own
-- site location, which this migration corrects). station_id remains the
-- separate cost-center/station attribution, and continues to resolve
-- business_date/timezone (an operational/site property, not a
-- storage-area property).
--
-- ============================================================
-- STORAGE-ELIGIBLE LOCATIONS
-- ============================================================
-- locations.is_storage_eligible, default FALSE. Backfilled TRUE, once,
-- for exactly the existing locations already proven in use by real
-- inventory/receiving data (PURCHASE_RECEIPT movements, receipt_lines,
-- inventory_stock_references, or an item's default_receiving_location_id)
-- -- a generic, data-driven rule that works for any organization, never a
-- name match. A DEV-only audit against the real Gansevoort organization
-- (reported alongside this migration) found real usage on BOTH
-- "Gansevoort Liberty Market -- WTC" (balance 72, 9 items default
-- there, 10 receipt lines, 5 stock references) and "Central Walk-In";
-- both backfill to true. The other four seeded Gansevoort storage
-- locations (Central Freezer, Dry Storage near Walk-In, Dry Storage C2,
-- Dry Storage C3) have zero historical usage and correctly backfill to
-- false -- scripts/seed-storage-locations.ts (their own authoritative,
-- already-committed provisioning script) is separately updated to mark
-- them eligible on its next run, rather than guessing that from a name
-- match inside this migration.
--
-- New locations must deliberately opt in (no more implicit true-by-
-- default); every test-fixture location-creation call site in this repo
-- is updated to pass is_storage_eligible: true explicitly.
--
-- ============================================================
-- LEGACY LOCATION ATTRIBUTION -- FROZEN AT CUTOVER, NEVER RECOMPUTED
-- ============================================================
-- inventory_movements.location_attribution: EXACT | LEGACY_ESTIMATED.
-- Backfilled by movement_type alone (never a timestamp heuristic): every
-- existing ISSUE_TO_STATION row becomes LEGACY_ESTIMATED (none of them
-- carry a genuine chosen source location); PURCHASE_RECEIPT and every new
-- source-aware movement is EXACT.
--
-- The historical V1 pro-rata allocation those LEGACY_ESTIMATED
-- withdrawals implied is computed ONCE, right now, using the exact
-- pre-cutover formula (outbound allocated by each location's share of
-- total inbound), and persisted into a new immutable table,
-- inventory_legacy_location_allocations. inventory_location_balances
-- reads this frozen snapshot directly from here on -- it is NEVER
-- recalculated against future inbound/transfer/count activity, so a new
-- purchase into "Central Walk-In" next month cannot reshuffle where an
-- old, already-frozen legacy estimate is attributed. New locations that
-- didn't exist at cutover naturally have no row here (nothing to freeze),
-- so they carry zero legacy estimate, correctly.
--
-- ============================================================
-- BALANCE FORMULA (see inventory_location_item_balance below)
-- ============================================================
--   balance(item, loc) =
--       exact inbound at loc (PURCHASE_RECEIPT + TRANSFER_IN + COUNT_ADJUSTMENT_IN)
--     - exact outbound at loc (ISSUE_TO_STATION + TRANSFER_OUT + WASTE +
--         COUNT_ADJUSTMENT_OUT, where location_attribution = 'EXACT')
--     - the frozen legacy allocation for (item, loc), read verbatim from
--         inventory_legacy_location_allocations (zero if none)
--
-- ============================================================
-- OTHER CHANGES
-- ============================================================
--   - movement_type widened to also allow TRANSFER_OUT, TRANSFER_IN,
--     WASTE, COUNT_ADJUSTMENT_IN, COUNT_ADJUSTMENT_OUT -- inert until
--     later-phase RPCs produce them; written now so the balance formula
--     above is correct immediately and never needs a second rewrite.
--   - inventory_movements_station_location_fk (which structurally forced
--     a movement's location to equal its station's own location) is
--     dropped; a plain composite (location_id, organization_id) FK to
--     locations replaces it.
--   - public.inventory_location_lock_key(...): one shared, deterministic
--     64-bit advisory-lock key derivation (hashtextextended, no
--     extension needed), used by every availability-sensitive RPC so
--     none of them roll their own hash. record_inventory_withdrawal uses
--     it to serialize "read current balance, validate, write movement"
--     at (organization, item, source location) granularity -- no mutable
--     balance row, no client-side availability check trusted.
--   - record_inventory_withdrawal: new required p_source_location_id
--     (old 8-arg signature dropped, matching this repo's own precedent
--     for required-param signature changes, e.g. 20260811100015).
--     Validates the location as active + storage-eligible; rejects
--     (GA022, distinct from HIGH_WITHDRAWAL, which still evaluates
--     independently and never blocks) a quantity exceeding the current
--     authoritative balance at that exact location, with NO partial
--     movement ever inserted. Idempotency payload comparison gains the
--     source location (actor/station/item/unit/quantity were already
--     compared).
--   - record_receipt: gains an explicit storage-eligibility check on
--     every receiving line's location (and p_default_location_id) --
--     the one 2A.4 surface this migration touches, narrowly and
--     additively, per the approved design.

-- ============================================================
-- 1. Storage-eligible locations
-- ============================================================
alter table public.locations add column is_storage_eligible boolean not null default false;

update public.locations l
   set is_storage_eligible = true
 where exists (
         select 1 from public.inventory_movements m
          where m.location_id = l.id and m.organization_id = l.organization_id and m.movement_type = 'PURCHASE_RECEIPT'
       )
    or exists (
         select 1 from public.receipt_lines rl
          where rl.location_id = l.id and rl.organization_id = l.organization_id
       )
    or exists (
         select 1 from public.inventory_stock_references r
          where r.location_id = l.id and r.organization_id = l.organization_id
       )
    or exists (
         select 1 from public.inventory_items ii
          where ii.default_receiving_location_id = l.id and ii.organization_id = l.organization_id
       );

-- ============================================================
-- 2. Frozen legacy location allocation (computed BEFORE the
--    location_attribution backfill below, though order doesn't matter
--    functionally -- this reads only historical inventory_movements rows,
--    which the new column doesn't affect).
-- ============================================================
create table public.inventory_legacy_location_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  inventory_item_id uuid not null,
  location_id uuid not null,
  allocated_outbound_quantity numeric not null,
  base_unit_id uuid not null references public.units (id),
  calculated_at timestamptz not null default now(),
  constraint inventory_legacy_location_allocations_qty_check check (allocated_outbound_quantity > 0),
  constraint inventory_legacy_location_allocations_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_legacy_location_allocations_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  -- at most one frozen estimate per (item, location) -- computed once,
  -- ever, by the INSERT below
  constraint inventory_legacy_location_allocations_item_location_key unique (organization_id, inventory_item_id, location_id)
);

create trigger inventory_legacy_location_allocations_forbid_update
  before update on public.inventory_legacy_location_allocations
  for each row execute function public.forbid_update_delete();

create trigger inventory_legacy_location_allocations_forbid_delete
  before delete on public.inventory_legacy_location_allocations
  for each row execute function public.forbid_update_delete();

alter table public.inventory_legacy_location_allocations enable row level security;

-- The exact pre-cutover V1 formula (20260811100064's original
-- inventory_location_balances body), computed once, per organization, and
-- persisted -- never re-derived after this statement commits.
insert into public.inventory_legacy_location_allocations (
  organization_id, inventory_item_id, location_id, allocated_outbound_quantity, base_unit_id
)
select i.organization_id, i.inventory_item_id, i.location_id,
       coalesce(o.qty, 0) * i.qty / t.total_qty,
       ii.base_unit_id
  from (
    select ml.inventory_item_id, m.organization_id, m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.movement_type = 'PURCHASE_RECEIPT'
     group by ml.inventory_item_id, m.organization_id, m.location_id
  ) i
  join (
    select inventory_item_id, organization_id, sum(qty) as total_qty
      from (
        select ml.inventory_item_id, m.organization_id, sum(ml.normalized_base_quantity) as qty
          from public.inventory_movement_lines ml
          join public.inventory_movements m on m.id = ml.movement_id
         where m.movement_type = 'PURCHASE_RECEIPT'
         group by ml.inventory_item_id, m.organization_id, m.location_id
      ) x
     group by inventory_item_id, organization_id
  ) t on t.inventory_item_id = i.inventory_item_id and t.organization_id = i.organization_id
  left join (
    select ml.inventory_item_id, m.organization_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.movement_type = 'ISSUE_TO_STATION'
     group by ml.inventory_item_id, m.organization_id
  ) o on o.inventory_item_id = i.inventory_item_id and o.organization_id = i.organization_id
  join public.inventory_items ii on ii.id = i.inventory_item_id
 where coalesce(o.qty, 0) * i.qty / t.total_qty > 0;

revoke all on public.inventory_legacy_location_allocations from public;
grant select on public.inventory_legacy_location_allocations to service_role;

-- ============================================================
-- 3. location_attribution -- structural marker, backfilled by
--    movement_type alone, never a timestamp
-- ============================================================
alter table public.inventory_movements
  add column location_attribution text not null default 'EXACT'
    check (location_attribution in ('EXACT', 'LEGACY_ESTIMATED'));

-- The append-only forbid-update trigger fires for every role, including
-- service_role, by design -- it must, to protect the ledger from a coding
-- mistake in ordinary application code. A brand-new column's one-time,
-- migration-time classification backfill is a genuinely different case:
-- narrowly disable just this one trigger for this one statement, inside
-- this same migration transaction, re-enabled immediately after -- no
-- application code ever observes the table as mutable, and no business
-- fact (quantity, item, location, actor, timestamp) is touched, only the
-- newly-added location_attribution column on rows that predate the
-- concept it records.
alter table public.inventory_movements disable trigger inventory_movements_forbid_update;

update public.inventory_movements
   set location_attribution = 'LEGACY_ESTIMATED'
 where movement_type = 'ISSUE_TO_STATION';

alter table public.inventory_movements enable trigger inventory_movements_forbid_update;

-- ============================================================
-- 4. movement_type widened (inert until later phases produce these)
-- ============================================================
alter table public.inventory_movements
  drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
    check (movement_type in (
      'PURCHASE_RECEIPT', 'ISSUE_TO_STATION',
      'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE',
      'COUNT_ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_OUT'
    ));

-- ============================================================
-- 5. Shared advisory-lock key
-- ============================================================
create or replace function public.inventory_location_lock_key(
  p_organization_id uuid, p_inventory_item_id uuid, p_location_id uuid
) returns bigint
language sql
immutable
set search_path = ''
as $$
  select hashtextextended(p_organization_id::text || ':' || p_inventory_item_id::text || ':' || p_location_id::text, 0);
$$;

revoke all on function public.inventory_location_lock_key(uuid, uuid, uuid) from public;
grant execute on function public.inventory_location_lock_key(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 6. Drop the station/location coupling FK; location is now an
--    independently chosen, validated storage location. The plain
--    (location_id, organization_id) -> locations(id, organization_id) FK
--    already exists from 20260811100005 (inventory_movements_location_
--    org_fk) and needs no change -- it already guarantees org-safety on
--    its own, independent of any station.
-- ============================================================
alter table public.inventory_movements
  drop constraint inventory_movements_station_location_fk;

-- ============================================================
-- 7. Single source of truth for "current balance at (org, item,
--    location)" -- used by both the withdrawal RPC's availability check
--    (locked, scalar) and the set-returning read model below (unlocked,
--    all rows). Kept in sync by hand (same three-term formula in both);
--    no shared abstraction beyond this comment, matching this schema's
--    existing style.
-- ============================================================
create or replace function public.inventory_location_item_balance(
  p_organization_id uuid, p_inventory_item_id uuid, p_location_id uuid
) returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select sum(ml.normalized_base_quantity)
        from public.inventory_movement_lines ml
        join public.inventory_movements m on m.id = ml.movement_id
       where m.organization_id = p_organization_id
         and m.location_id = p_location_id
         and ml.inventory_item_id = p_inventory_item_id
         and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
    ), 0)
    - coalesce((
      select sum(ml.normalized_base_quantity)
        from public.inventory_movement_lines ml
        join public.inventory_movements m on m.id = ml.movement_id
       where m.organization_id = p_organization_id
         and m.location_id = p_location_id
         and ml.inventory_item_id = p_inventory_item_id
         and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
         and m.location_attribution = 'EXACT'
    ), 0)
    - coalesce((
      select a.allocated_outbound_quantity
        from public.inventory_legacy_location_allocations a
       where a.organization_id = p_organization_id
         and a.inventory_item_id = p_inventory_item_id
         and a.location_id = p_location_id
    ), 0);
$$;

revoke all on function public.inventory_location_item_balance(uuid, uuid, uuid) from public;
grant execute on function public.inventory_location_item_balance(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 8. inventory_location_balances / list_inventory_balances -- exact +
--    frozen-legacy formula, same signatures. list_inventory_balances
--    gains out_includes_legacy_estimate (server-computed, never guessed
--    client-side).
-- ============================================================
-- Return shape changed (out_inbound_quantity/out_allocated_outbound_
-- quantity dropped, out_legacy_allocation added) -- CREATE OR REPLACE
-- cannot change a function's OUT-parameter row type, so the old
-- definition is dropped first. post_purchase_document_inventory (100066/
-- 100068) and every TS caller only ever read out_inventory_item_id,
-- out_location_id, out_balance -- all three survive unchanged.
drop function if exists public.inventory_location_balances(uuid);

create function public.inventory_location_balances(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_location_id uuid,
  out_balance numeric,
  out_legacy_allocation numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with inbound as (
    select ml.inventory_item_id, m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
     group by ml.inventory_item_id, m.location_id
  ),
  exact_outbound as (
    select ml.inventory_item_id, m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
       and m.location_attribution = 'EXACT'
     group by ml.inventory_item_id, m.location_id
  ),
  legacy as (
    select inventory_item_id, location_id, allocated_outbound_quantity as qty
      from public.inventory_legacy_location_allocations
     where organization_id = p_organization_id
  ),
  locations_touched as (
    select inventory_item_id, location_id from inbound
    union
    select inventory_item_id, location_id from exact_outbound
    union
    select inventory_item_id, location_id from legacy
  )
  select
    lt.inventory_item_id,
    lt.location_id,
    coalesce(i.qty, 0) - coalesce(eo.qty, 0) - coalesce(lg.qty, 0),
    coalesce(lg.qty, 0)
  from locations_touched lt
  left join inbound i on i.inventory_item_id = lt.inventory_item_id and i.location_id = lt.location_id
  left join exact_outbound eo on eo.inventory_item_id = lt.inventory_item_id and eo.location_id = lt.location_id
  left join legacy lg on lg.inventory_item_id = lt.inventory_item_id and lg.location_id = lt.location_id;
$$;

revoke all on function public.inventory_location_balances(uuid) from public;
grant execute on function public.inventory_location_balances(uuid) to service_role;

-- Return shape changed (out_includes_legacy_estimate added) -- same
-- drop-first requirement as inventory_location_balances above.
drop function if exists public.list_inventory_balances(uuid);

create function public.list_inventory_balances(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_item_name text,
  out_location_id uuid,
  out_location_name text,
  out_base_unit_code text,
  out_balance numeric,
  out_full_reference_quantity numeric,
  out_reference_source text,
  out_reference_set_at timestamptz,
  out_includes_legacy_estimate boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.out_inventory_item_id,
    ii.name,
    b.out_location_id,
    loc.name,
    u.code,
    b.out_balance,
    ref.full_quantity,
    ref.source,
    ref.created_at,
    b.out_legacy_allocation > 0
  from public.inventory_location_balances(p_organization_id) b
  join public.inventory_items ii on ii.id = b.out_inventory_item_id
  join public.units u on u.id = ii.base_unit_id
  join public.locations loc on loc.id = b.out_location_id
  left join lateral (
    select r.full_quantity, r.source, r.created_at
      from public.inventory_stock_references r
     where r.organization_id = p_organization_id
       and r.inventory_item_id = b.out_inventory_item_id
       and r.location_id = b.out_location_id
     order by r.created_at desc, r.id desc
     limit 1
  ) ref on true
  order by ii.name, loc.name;
$$;

revoke all on function public.list_inventory_balances(uuid) from public;
grant execute on function public.list_inventory_balances(uuid) to service_role;

-- ============================================================
-- 9. record_inventory_withdrawal -- exact source-aware withdrawal
-- ============================================================
drop function if exists public.record_inventory_withdrawal(
  uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
);

create function public.record_inventory_withdrawal(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_inventory_item_id uuid,
  p_source_location_id uuid,
  p_entered_quantity numeric,
  p_entered_unit_id uuid,
  p_measured_base_quantity numeric default null,
  p_notes text default null,
  p_client_request_id uuid default null
)
returns table (
  movement_id uuid,
  movement_line_id uuid,
  normalized_base_quantity numeric,
  base_unit_id uuid,
  exception_id uuid,
  exception_raised boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
  v_employee_status text;
  v_default_station_id uuid;
  v_auto_resolve_station boolean;
  v_can_change_station boolean;
  v_station_location_id uuid;
  v_timezone text;
  v_business_date date;
  v_movement_id uuid;
  v_line_id uuid;
  v_normalized numeric;
  v_base_unit_id uuid;
  v_rule_id uuid;
  v_threshold numeric;
  v_exception_id uuid;
  v_existing record;
  v_current_balance numeric;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  -- 1. Resolve and validate the acting employee. Never trust organization_id
  -- from the caller -- it is derived here from the app_user.
  select au.organization_id, au.employee_id
    into v_org_id, v_employee_id
    from public.app_users au
   where au.id = p_performed_by_app_user_id
     and au.is_active;

  if not found then
    raise exception 'performed_by_app_user_id % is not an active app user', p_performed_by_app_user_id;
  end if;

  -- 2. Idempotency check. A retry must match the ORIGINAL request on every
  -- security/business-significant field -- actor, station, item, SOURCE
  -- LOCATION, entered unit, entered quantity, and measured_base_quantity
  -- -- or the call fails closed instead of silently replaying a different
  -- withdrawal (Milestone 2A.5: source location joins this comparison).
  select im.id as existing_movement_id,
         im.performed_by_app_user_id as existing_performed_by_app_user_id,
         im.station_id as existing_station_id,
         im.location_id as existing_location_id,
         ml.id as existing_movement_line_id,
         ml.inventory_item_id as existing_inventory_item_id,
         ml.entered_quantity as existing_entered_quantity,
         ml.entered_unit_id as existing_entered_unit_id,
         ml.measured_base_quantity as existing_measured_base_quantity,
         ml.normalized_base_quantity as existing_normalized_base_quantity,
         ml.base_unit_id as existing_base_unit_id,
         ex.id as existing_exception_id
    into v_existing
    from public.inventory_movements im
    join public.inventory_movement_lines ml on ml.movement_id = im.id
    left join public.exceptions ex on ex.source_movement_line_id = ml.id
   where im.organization_id = v_org_id
     and im.client_request_id = p_client_request_id;

  if found then
    if v_existing.existing_performed_by_app_user_id is distinct from p_performed_by_app_user_id
       or v_existing.existing_station_id is distinct from p_station_id
       or v_existing.existing_location_id is distinct from p_source_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_entered_unit_id is distinct from p_entered_unit_id
       or v_existing.existing_entered_quantity is distinct from p_entered_quantity
       or v_existing.existing_measured_base_quantity is distinct from p_measured_base_quantity
    then
      raise exception 'client_request_id % was already used with a different withdrawal payload', p_client_request_id;
    end if;

    return query select
      v_existing.existing_movement_id,
      v_existing.existing_movement_line_id,
      v_existing.existing_normalized_base_quantity,
      v_existing.existing_base_unit_id,
      v_existing.existing_exception_id,
      v_existing.existing_exception_id is not null,
      true;
    return;
  end if;

  select e.status, e.default_station_id, e.auto_resolve_station, e.can_change_station
    into v_employee_status, v_default_station_id, v_auto_resolve_station, v_can_change_station
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization: an employee locked to their default station
  -- may not submit a withdrawal for any other station, regardless of what
  -- the caller sent.
  if v_auto_resolve_station and not v_can_change_station then
    if p_station_id is distinct from v_default_station_id then
      raise exception 'employee % is restricted to their default station and may not use station %',
        v_employee_id, p_station_id;
    end if;
  end if;

  -- 4. Active-record validation. The station still resolves the
  -- OPERATIONAL business_date/timezone (a site property) -- it no longer
  -- determines the movement's location, which is the caller-chosen
  -- SOURCE STORAGE location instead (2A.5).
  select s.location_id
    into v_station_location_id
    from public.stations s
   where s.id = p_station_id
     and s.organization_id = v_org_id
     and s.is_active;

  if not found then
    raise exception 'station_id % is not an active station in organization %', p_station_id, v_org_id;
  end if;

  select l.timezone
    into v_timezone
    from public.locations l
   where l.id = v_station_location_id
     and l.is_active;

  if not found then
    raise exception 'location for station_id % is not active', p_station_id;
  end if;

  if not exists (
    select 1 from public.locations
     where id = p_source_location_id and organization_id = v_org_id and is_active and is_storage_eligible
  ) then
    raise exception 'source_location_id % is not an active storage-eligible location in organization %', p_source_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  perform 1
    from public.inventory_items i
   where i.id = p_inventory_item_id
     and i.organization_id = v_org_id
     and i.status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id;
  end if;

  v_business_date := (now() at time zone v_timezone)::date;

  -- 5. Serialize on (organization, item, SOURCE LOCATION) before reading
  -- the authoritative current balance -- no client-side availability
  -- check is ever trusted, and no mutable balance row exists to lock
  -- instead. Transaction-scoped: released automatically at commit/
  -- rollback.
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_source_location_id));

  -- The measurement trigger below computes normalized_base_quantity
  -- authoritatively; entered_quantity in base units is already what a
  -- non-measured ISSUE_TO_STATION line normalizes to 1:1 (base-unit-only,
  -- enforced by enforce_movement_line_measurement). For a
  -- requires-measurement item, p_measured_base_quantity IS the
  -- normalized quantity -- use it directly for the availability check so
  -- a measured withdrawal is validated against its own actual measured
  -- amount, never its nominal entered count.
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_source_location_id);

  if coalesce(p_measured_base_quantity, p_entered_quantity) > v_current_balance then
    raise exception 'only % is currently available for inventory_item % at location % (requested %)',
      v_current_balance, p_inventory_item_id, p_source_location_id, coalesce(p_measured_base_quantity, p_entered_quantity)
      using errcode = 'GA022';
  end if;

  -- 6. Movement header. location_id is now the chosen SOURCE STORAGE
  -- location (not the station's site); location_attribution is EXACT --
  -- this is a genuinely chosen, not estimated, source.
  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id, location_attribution
    ) values (
      v_org_id, p_source_location_id, p_station_id, 'ISSUE_TO_STATION',
      p_performed_by_app_user_id, v_business_date, p_notes, p_client_request_id, 'EXACT'
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    -- Two genuinely concurrent identical retries: both passed the
    -- idempotency check above (neither had committed yet), only one
    -- insert wins the partial unique index; the loser re-reads the
    -- winner's now-committed row and returns the identical result rather
    -- than erroring.
    select im.id as existing_movement_id,
           im.performed_by_app_user_id as existing_performed_by_app_user_id,
           im.station_id as existing_station_id,
           im.location_id as existing_location_id,
           ml.id as existing_movement_line_id,
           ml.inventory_item_id as existing_inventory_item_id,
           ml.entered_quantity as existing_entered_quantity,
           ml.entered_unit_id as existing_entered_unit_id,
           ml.measured_base_quantity as existing_measured_base_quantity,
           ml.normalized_base_quantity as existing_normalized_base_quantity,
           ml.base_unit_id as existing_base_unit_id,
           ex.id as existing_exception_id
      into v_existing
      from public.inventory_movements im
      join public.inventory_movement_lines ml on ml.movement_id = im.id
      left join public.exceptions ex on ex.source_movement_line_id = ml.id
     where im.organization_id = v_org_id
       and im.client_request_id = p_client_request_id;

    if not found then
      raise exception 'client_request_id % conflicted but no matching movement was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_performed_by_app_user_id is distinct from p_performed_by_app_user_id
       or v_existing.existing_station_id is distinct from p_station_id
       or v_existing.existing_location_id is distinct from p_source_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_entered_unit_id is distinct from p_entered_unit_id
       or v_existing.existing_entered_quantity is distinct from p_entered_quantity
       or v_existing.existing_measured_base_quantity is distinct from p_measured_base_quantity
    then
      raise exception 'client_request_id % was already used with a different withdrawal payload', p_client_request_id;
    end if;

    return query select
      v_existing.existing_movement_id,
      v_existing.existing_movement_line_id,
      v_existing.existing_normalized_base_quantity,
      v_existing.existing_base_unit_id,
      v_existing.existing_exception_id,
      v_existing.existing_exception_id is not null,
      true;
    return;
  end;

  -- 7. Movement line. enforce_movement_line_measurement() validates the
  -- item/unit pair and computes organization_id, base_unit_id, and
  -- normalized_base_quantity.
  insert into public.inventory_movement_lines as ml (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  ) values (
    v_movement_id, p_inventory_item_id, p_entered_quantity, p_entered_unit_id, p_measured_base_quantity
  ) returning ml.id, ml.normalized_base_quantity, ml.base_unit_id
    into v_line_id, v_normalized, v_base_unit_id;

  -- 8. HIGH_WITHDRAWAL check -- an operational anomaly signal, evaluated
  -- independently of and never blocking on availability (2A.5: keep
  -- these two concepts separate, per spec).
  select cr.id, cr.threshold_quantity
    into v_rule_id, v_threshold
    from public.control_rules cr
   where cr.organization_id = v_org_id
     and cr.inventory_item_id = p_inventory_item_id
     and cr.rule_type = 'HIGH_WITHDRAWAL'
     and cr.is_active
     and cr.station_id = p_station_id;

  if not found then
    select cr.id, cr.threshold_quantity
      into v_rule_id, v_threshold
      from public.control_rules cr
     where cr.organization_id = v_org_id
       and cr.inventory_item_id = p_inventory_item_id
       and cr.rule_type = 'HIGH_WITHDRAWAL'
       and cr.is_active
       and cr.station_id is null;
  end if;

  if found and v_normalized > v_threshold then
    insert into public.exceptions as ex (
      organization_id, exception_type, control_rule_id,
      source_movement_id, source_movement_line_id, inventory_item_id, station_id,
      observed_quantity, threshold_quantity_at_detection, base_unit_id
    ) values (
      v_org_id, 'HIGH_WITHDRAWAL', v_rule_id,
      v_movement_id, v_line_id, p_inventory_item_id, p_station_id,
      v_normalized, v_threshold, v_base_unit_id
    ) returning ex.id into v_exception_id;
  end if;

  -- 9. Audit event.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    v_org_id, p_performed_by_app_user_id, 'INVENTORY_WITHDRAWAL_RECORDED',
    'inventory_movement', v_movement_id,
    jsonb_build_object(
      'movement_line_id', v_line_id, 'inventory_item_id', p_inventory_item_id,
      'station_id', p_station_id, 'source_location_id', p_source_location_id,
      'entered_quantity', p_entered_quantity,
      'entered_unit_id', p_entered_unit_id, 'measured_base_quantity', p_measured_base_quantity,
      'normalized_base_quantity', v_normalized, 'base_unit_id', v_base_unit_id,
      'exception_id', v_exception_id
    )
  );

  return query select v_movement_id, v_line_id, v_normalized, v_base_unit_id, v_exception_id, v_exception_id is not null, false;
end;
$$;

revoke all on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) from public;
grant execute on function public.record_inventory_withdrawal(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, text, uuid
) to service_role;

-- ============================================================
-- 10. record_receipt -- storage-eligibility check (the one 2A.4 surface
--     touched this migration)
-- ============================================================
create or replace function public.record_receipt(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_receipt_kind text,
  p_purchase_document_id uuid default null,
  p_corrects_receipt_id uuid default null,
  p_default_location_id uuid default null,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb,
  p_idempotency_key text default null
)
returns table (
  out_receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_doc_status text;
  v_doc_created_by uuid;
  v_effective_pd_id uuid;
  v_source_document_id uuid;
  v_verifier uuid;
  v_existing_receipt_id uuid;
  v_line jsonb;
  v_matched_line_key uuid;
  v_classification record;
  v_received_qty numeric;
  v_received_unit text;
  v_client_verified_qty numeric;
  v_server_verified_qty numeric;
  v_server_verified_unit_id uuid;
begin
  if p_receipt_kind not in ('DELIVERY', 'CORRECTION') then
    raise exception 'invalid receipt_kind %', p_receipt_kind;
  end if;

  -- Milestone 2A.5 (20260811100073): every location a receiving line
  -- targets must be an active, STORAGE-eligible location -- never a
  -- site/business location a station merely belongs to. Checked once,
  -- covering both p_default_location_id and every line's own locationId,
  -- before anything is written.
  if p_default_location_id is not null and not exists (
    select 1 from public.locations
     where id = p_default_location_id and organization_id = p_organization_id and is_active and is_storage_eligible
  ) then
    raise exception 'location % is not an active storage-eligible location in organization %', p_default_location_id, p_organization_id
      using errcode = 'GA021';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
     where line.value ->> 'locationId' is not null
       and not exists (
             select 1 from public.locations
              where id = (line.value ->> 'locationId')::uuid
                and organization_id = p_organization_id
                and is_active
                and is_storage_eligible
           )
  ) then
    raise exception 'one or more receiving lines target a location that is not an active storage-eligible location in organization %', p_organization_id
      using errcode = 'GA021';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_receipt_id
      from public.receipts
     where organization_id = p_organization_id
       and idempotency_key = p_idempotency_key;

    if found then
      -- A genuine replay of an already-recorded request -- return the
      -- SAME receipt, insert nothing new.
      return query select v_existing_receipt_id;
      return;
    end if;
  end if;

  if p_receipt_kind = 'CORRECTION' then
    if p_corrects_receipt_id is null then
      raise exception 'corrects_receipt_id is required for a CORRECTION receipt';
    end if;

    select purchase_document_id into v_effective_pd_id
      from public.receipts
     where id = p_corrects_receipt_id and organization_id = p_organization_id;

    if not found then
      raise exception 'receipt % not found', p_corrects_receipt_id
        using errcode = 'GA012';
    end if;

    -- Reviewer receiving-correction window: during READY_FOR_VERIFICATION
    -- a CORRECTION is the sanctioned Manager 2 path -- but never for the
    -- preparer (the same no-self-review rule as verify itself), and the
    -- trigger capability is granted only here, so VERIFIED/DISCARDED
    -- corrections remain blocked exactly as before.
    select status, created_by_app_user_id into v_doc_status, v_doc_created_by
      from public.purchase_documents
     where id = v_effective_pd_id and organization_id = p_organization_id;

    if v_doc_status = 'READY_FOR_VERIFICATION' then
      if v_doc_created_by = p_app_user_id then
        raise exception 'app_user % prepared purchase_document % and cannot review-correct its receiving', p_app_user_id, v_effective_pd_id
          using errcode = 'GA004';
      end if;
      perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
    end if;
  else
    if p_purchase_document_id is null then
      raise exception 'purchase_document_id is required for a DELIVERY receipt';
    end if;

    if not exists (select 1 from public.purchase_documents where id = p_purchase_document_id and organization_id = p_organization_id) then
      raise exception 'purchase_document % not found', p_purchase_document_id
        using errcode = 'GA012';
    end if;

    v_effective_pd_id := p_purchase_document_id;
  end if;

  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = v_effective_pd_id;

  v_verifier := public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id);

  v_receipt_id := gen_random_uuid();

  begin
    insert into public.receipts (
      id, organization_id, purchase_document_id, receipt_kind, corrects_receipt_id,
      default_location_id, delivery_verified_by_employee_id_snapshot, recorded_by_app_user_id, notes, idempotency_key
    ) values (
      v_receipt_id, p_organization_id, v_effective_pd_id, p_receipt_kind, p_corrects_receipt_id,
      p_default_location_id, v_verifier, p_app_user_id, p_notes, p_idempotency_key
    );
  exception when unique_violation then
    -- Lost a genuine race against another caller using the same key --
    -- the winner's row is now visible; return it rather than erroring.
    if p_idempotency_key is not null then
      select id into v_existing_receipt_id
        from public.receipts
       where organization_id = p_organization_id
         and idempotency_key = p_idempotency_key;
      if found then
        return query select v_existing_receipt_id;
        return;
      end if;
    end if;
    raise;
  end;

  -- FIXED_CONVERSION integrity: recompute/validate each line's verified
  -- base quantity server-side, per line, rather than trusting the
  -- client's math. SAME_UNIT/MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY
  -- lines (no resolvable purchase-unit conversion row) fall through
  -- completely untouched.
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as t(value)
  loop
    v_matched_line_key := nullif(v_line ->> 'matchedLineKey', '')::uuid;
    v_server_verified_qty := null;
    v_server_verified_unit_id := null;

    if v_matched_line_key is not null then
      select ii.base_unit_id, bu.code as base_unit_code,
             pu.code as purchase_unit_code, piu.conversion_factor
        into v_classification
        from public.purchase_document_line_classifications c
        join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = c.organization_id
        join public.units bu on bu.id = ii.base_unit_id
        left join public.inventory_item_units piu
          on piu.inventory_item_id = ii.id and piu.unit_id <> ii.base_unit_id and piu.requires_actual_measurement = false
        left join public.units pu on pu.id = piu.unit_id
       where c.purchase_document_id = v_effective_pd_id
         and c.organization_id = p_organization_id
         and c.line_key = v_matched_line_key
         and c.status = 'CONFIRMED'
         and c.disposition = 'INVENTORY';

      if found and v_classification.purchase_unit_code is not null and v_classification.conversion_factor is not null then
        v_received_qty := (v_line ->> 'actualReceivedPackageQuantity')::numeric;
        v_received_unit := v_line ->> 'actualReceivedPackageUnit';
        v_client_verified_qty := nullif(v_line ->> 'actualVerifiedBaseQuantity', '')::numeric;

        if v_received_qty is not null and v_received_unit is not null then
          if lower(btrim(v_received_unit)) = lower(btrim(v_classification.purchase_unit_code)) then
            v_server_verified_qty := v_received_qty * v_classification.conversion_factor;
          elsif lower(btrim(v_received_unit)) = lower(btrim(v_classification.base_unit_code)) then
            v_server_verified_qty := v_received_qty;
          else
            raise exception 'line % received unit "%" does not match the item''s purchase unit (%) or base unit (%) -- cannot verify a FIXED_CONVERSION quantity',
              v_matched_line_key, v_received_unit, v_classification.purchase_unit_code, v_classification.base_unit_code
              using errcode = 'GA015';
          end if;

          if v_client_verified_qty is not null and v_client_verified_qty <> v_server_verified_qty then
            raise exception 'line % verified quantity % is inconsistent with % % at 1 % = % % -- expected %',
              v_matched_line_key, v_client_verified_qty, v_received_qty, v_received_unit,
              v_classification.purchase_unit_code, v_classification.conversion_factor, v_classification.base_unit_code, v_server_verified_qty
              using errcode = 'GA015';
          end if;

          v_server_verified_unit_id := v_classification.base_unit_id;
        end if;
      end if;
    end if;

    insert into public.receipt_lines (
      id, receipt_id, organization_id, line_number_snapshot, matched_line_key,
      vendor_sku_snapshot, description_snapshot,
      invoice_package_quantity, invoice_package_unit, invoice_measured_quantity, invoice_measured_unit,
      actual_received_package_quantity, actual_received_package_unit,
      actual_verified_base_quantity, actual_verified_base_unit_id,
      location_id, condition_status, notes
    ) values (
      gen_random_uuid(), v_receipt_id, p_organization_id,
      (v_line ->> 'lineNumberSnapshot')::integer,
      v_matched_line_key,
      v_line ->> 'vendorSkuSnapshot', v_line ->> 'descriptionSnapshot',
      (v_line ->> 'invoicePackageQuantity')::numeric, v_line ->> 'invoicePackageUnit',
      (v_line ->> 'invoiceMeasuredQuantity')::numeric, v_line ->> 'invoiceMeasuredUnit',
      (v_line ->> 'actualReceivedPackageQuantity')::numeric, v_line ->> 'actualReceivedPackageUnit',
      -- FIXED_CONVERSION lines: always the server's own recomputed value
      -- (never the raw client one, even when it agreed). Every other
      -- line: passed through exactly as submitted, unchanged.
      coalesce(v_server_verified_qty, (v_line ->> 'actualVerifiedBaseQuantity')::numeric),
      coalesce(v_server_verified_unit_id, (v_line ->> 'actualVerifiedBaseUnitId')::uuid),
      (v_line ->> 'locationId')::uuid,
      coalesce(v_line ->> 'conditionStatus', 'RECEIVED_AS_INVOICED'),
      v_line ->> 'notes'
    );
  end loop;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'RECEIPT_RECORDED', 'purchase_document', v_effective_pd_id,
    jsonb_build_object(
      'receiptId', v_receipt_id, 'receiptKind', p_receipt_kind, 'correctsReceiptId', p_corrects_receipt_id,
      'deliveryVerifiedByEmployeeId', v_verifier
    ));

  return query select v_receipt_id;
end;
$$;

revoke all on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text) from public;
grant execute on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb, text) to service_role;
