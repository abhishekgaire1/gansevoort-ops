-- Cycle Counts / Physical Inventory Reconciliation.
--
-- Storage-to-storage transfers and waste are explicitly NOT part of this
-- migration (deferred). 2A.5 exact source-aware withdrawals remain frozen;
-- this migration is purely additive and does not touch record_inventory_
-- withdrawal, record_inventory_withdrawal_batch, or their locking/
-- idempotency behavior.
--
-- ============================================================
-- KEY PRINCIPLE
-- ============================================================
-- A cycle count is a PHYSICAL TRUTH EVENT. The manager records what is
-- physically there NOW; the server computes the required adjustment.
-- Inventory ledger truth is never rewritten -- a completed count produces
-- ordinary COUNT_ADJUSTMENT_IN/COUNT_ADJUSTMENT_OUT movements, exactly like
-- every other movement type, so the resulting balance (via
-- inventory_location_item_balance, unchanged) equals the physical count by
-- construction (physical - previous_balance = variance = the adjustment).
--
-- movement_type already permits COUNT_ADJUSTMENT_IN/COUNT_ADJUSTMENT_OUT
-- (added inert in 20260811100073) and the balance formula already sums
-- them with the correct sign -- this migration is the first thing that
-- actually produces them.
--
-- ============================================================
-- OPTIMISTIC COUNTING, AUTHORITATIVE FINALIZATION
-- ============================================================
-- Adding items and entering physical counts never locks anything and never
-- touches the ledger -- pure DRAFT scratch state on inventory_cycle_count_
-- lines. Only complete_cycle_count acquires locks (the SAME shared
-- inventory_location_lock_key(...) every other availability-sensitive RPC
-- uses, in the SAME deterministic ascending order), re-reads authoritative
-- balances, and writes the ledger -- atomically, all-or-nothing.
--
-- Staleness is detected via a per-(org, item, location) monotonic ledger-
-- line-count watermark (inventory_location_item_ledger_line_count below,
-- mirroring inventory_location_item_balance's own inbound/exact-outbound
-- predicate) captured alongside each line's expected-quantity snapshot: the
-- ledger is append-only, so any intervening activity strictly increases
-- this count, even when net balance nets back to the same number. No such
-- watermark existed anywhere else in the schema before this migration.
--
-- ============================================================
-- WHAT'S NEW
-- ============================================================
--   - inventory_cycle_counts: one row per physical-count session, scoped to
--     exactly one (organization, storage-eligible location). At most one
--     DRAFT per (organization, location) -- enforced by a partial unique
--     index, not just application logic.
--   - inventory_cycle_count_lines: one row per (cycle_count, inventory_item)
--     -- the physical observation for that item, plus its expected-quantity
--     and ledger-watermark snapshot. physical_count_quantity nullable:
--     null means "not counted, no change" -- an explicit 0 is a genuine
--     physical observation of zero, never conflated with "blank."
--   - inventory_location_item_ledger_line_count(...): the stale-detection
--     watermark (see above).
--   - inventory_movements.cycle_count_id / inventory_movement_lines.
--     cycle_count_line_id: nullable traceability links from a resulting
--     adjustment movement back to the physical count that produced it. The
--     count table stores the physical observation; the ledger stores the
--     resulting change -- these links connect them without duplicating
--     quantity truth.
--   - start_or_resume_cycle_count / add_cycle_count_line /
--     record_cycle_count_line_observation / complete_cycle_count /
--     cancel_cycle_count: the RPC surface (Phase A-C below, in one
--     migration for cohesion).
--   - list_inventory_balances.out_includes_legacy_estimate additionally
--     requires that NO completed physical reconciliation exists yet for
--     that (item, location) -- a successful count (even a zero-variance
--     one) clears the historical uncertainty going forward, without ever
--     editing the frozen inventory_legacy_location_allocations row itself.

-- ============================================================
-- 1. inventory_cycle_counts
-- ============================================================
create table public.inventory_cycle_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  status text not null default 'DRAFT',
  started_by_app_user_id uuid not null,
  started_at timestamptz not null default now(),
  completed_by_app_user_id uuid,
  completed_at timestamptz,
  cancelled_by_app_user_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_cycle_counts_status_check check (status in ('DRAFT', 'COMPLETED', 'CANCELLED')),
  constraint inventory_cycle_counts_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint inventory_cycle_counts_started_by_org_fk foreign key (started_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_cycle_counts_completed_by_org_fk foreign key (completed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_cycle_counts_cancelled_by_org_fk foreign key (cancelled_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_cycle_counts_completed_fields_check
    check (status <> 'COMPLETED' or (completed_by_app_user_id is not null and completed_at is not null)),
  constraint inventory_cycle_counts_cancelled_fields_check
    check (status <> 'CANCELLED' or (cancelled_by_app_user_id is not null and cancelled_at is not null)),
  -- composite-FK target for cycle_count_lines/movements below
  constraint inventory_cycle_counts_id_org_key unique (id, organization_id)
);

-- At most one open (DRAFT) session per storage location -- two managers can
-- never independently start competing counts for the same location; the UI
-- surfaces "Resume Cycle Count" instead (Part 9).
create unique index inventory_cycle_counts_one_draft_per_location
  on public.inventory_cycle_counts (organization_id, location_id)
  where status = 'DRAFT';

create index inventory_cycle_counts_org_idx on public.inventory_cycle_counts (organization_id);

-- DRAFT is freely editable (status/version transitions only, via the RPCs
-- below); COMPLETED and CANCELLED are immutable -- reuses GA003 (the
-- existing "locked" code, same pattern as purchase_documents_forbid_
-- locked_mutation) rather than minting a new one for the identical
-- semantic. Never hard-deleted, in any status (Part 32).
create or replace function public.inventory_cycle_counts_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_cycle_count % may never be deleted', old.id
      using errcode = 'GA003';
  end if;

  if old.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'inventory_cycle_count % is % and cannot be modified', old.id, old.status
      using errcode = 'GA003';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger inventory_cycle_counts_forbid_locked_update
  before update on public.inventory_cycle_counts
  for each row execute function public.inventory_cycle_counts_forbid_locked_mutation();

create trigger inventory_cycle_counts_forbid_locked_delete
  before delete on public.inventory_cycle_counts
  for each row execute function public.inventory_cycle_counts_forbid_locked_mutation();

alter table public.inventory_cycle_counts enable row level security;
-- Deny-by-default: no policies for anon/authenticated. Only the RPCs below
-- (security definer) ever write this table.
revoke all on public.inventory_cycle_counts from public;
grant select on public.inventory_cycle_counts to service_role;

-- ============================================================
-- 2. inventory_cycle_count_lines
-- ============================================================
create table public.inventory_cycle_count_lines (
  id uuid primary key default gen_random_uuid(),
  cycle_count_id uuid not null,
  organization_id uuid not null,
  inventory_item_id uuid not null,
  base_unit_id uuid not null references public.units (id),
  expected_quantity_at_snapshot numeric not null,
  ledger_line_count_at_snapshot integer not null,
  -- null = NOT COUNTED, no change (Part 27) -- an explicit 0 is a genuine
  -- physical observation, stored as 0, never conflated with null.
  physical_count_quantity numeric,
  counted_by_app_user_id uuid,
  counted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint inventory_cycle_count_lines_expected_qty_check check (expected_quantity_at_snapshot >= 0),
  constraint inventory_cycle_count_lines_watermark_check check (ledger_line_count_at_snapshot >= 0),
  constraint inventory_cycle_count_lines_physical_qty_check check (physical_count_quantity is null or physical_count_quantity >= 0),
  constraint inventory_cycle_count_lines_counted_fields_check
    check (physical_count_quantity is null or (counted_by_app_user_id is not null and counted_at is not null)),
  constraint inventory_cycle_count_lines_cycle_count_org_fk foreign key (cycle_count_id, organization_id)
    references public.inventory_cycle_counts (id, organization_id),
  constraint inventory_cycle_count_lines_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_cycle_count_lines_counted_by_org_fk foreign key (counted_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  -- one item appears only once per count session (Part 8)
  constraint inventory_cycle_count_lines_item_key unique (cycle_count_id, inventory_item_id),
  -- composite-FK target for inventory_movement_lines below
  constraint inventory_cycle_count_lines_id_org_key unique (id, organization_id)
);

create index inventory_cycle_count_lines_cycle_count_idx on public.inventory_cycle_count_lines (cycle_count_id);
create index inventory_cycle_count_lines_item_idx on public.inventory_cycle_count_lines (organization_id, inventory_item_id);

-- Mutable while the PARENT count is DRAFT (physical_count_quantity is
-- ordinary optimistic scratch state, re-enterable/correctable while
-- counting); frozen the instant the parent leaves DRAFT. Never deleted --
-- a zero-variance completed line is still a meaningful physical-
-- reconciliation fact (Part 31), and an added-but-never-counted line is
-- harmless historical scratch, not worth a separate remove path this
-- milestone.
create or replace function public.inventory_cycle_count_lines_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
declare
  v_parent_status text;
begin
  select status into v_parent_status
    from public.inventory_cycle_counts
   where id = coalesce(old.cycle_count_id, new.cycle_count_id);

  if tg_op = 'DELETE' then
    raise exception 'inventory_cycle_count_line % may never be deleted', old.id
      using errcode = 'GA003';
  end if;

  if v_parent_status is distinct from 'DRAFT' then
    raise exception 'inventory_cycle_count_line % belongs to a % cycle count and cannot be modified', old.id, v_parent_status
      using errcode = 'GA003';
  end if;

  return new;
end;
$$;

create trigger inventory_cycle_count_lines_forbid_locked_update
  before update on public.inventory_cycle_count_lines
  for each row execute function public.inventory_cycle_count_lines_forbid_locked_mutation();

create trigger inventory_cycle_count_lines_forbid_locked_delete
  before delete on public.inventory_cycle_count_lines
  for each row execute function public.inventory_cycle_count_lines_forbid_locked_mutation();

alter table public.inventory_cycle_count_lines enable row level security;
revoke all on public.inventory_cycle_count_lines from public;
grant select on public.inventory_cycle_count_lines to service_role;

-- ============================================================
-- 3. Traceability: movement -> cycle count (Part 17)
-- ============================================================
alter table public.inventory_movements add column cycle_count_id uuid;

alter table public.inventory_movements
  add constraint inventory_movements_cycle_count_org_fk
  foreign key (cycle_count_id, organization_id)
  references public.inventory_cycle_counts (id, organization_id);

create index inventory_movements_cycle_count_idx
  on public.inventory_movements (cycle_count_id)
  where cycle_count_id is not null;

alter table public.inventory_movement_lines add column cycle_count_line_id uuid;

alter table public.inventory_movement_lines
  add constraint inventory_movement_lines_cycle_count_line_org_fk
  foreign key (cycle_count_line_id, organization_id)
  references public.inventory_cycle_count_lines (id, organization_id);

create index inventory_movement_lines_cycle_count_line_idx
  on public.inventory_movement_lines (cycle_count_line_id)
  where cycle_count_line_id is not null;

-- ============================================================
-- 4. Stale-detection watermark (Part 10-11) -- mirrors inventory_location_
--    item_balance's own inbound/exact-outbound predicate exactly, so
--    "watermark unchanged" is provably equivalent to "balance unchanged"
--    (the only other term in the balance formula, the frozen legacy
--    allocation, never changes after 20260811100073's one-time backfill).
-- ============================================================
create or replace function public.inventory_location_item_ledger_line_count(
  p_organization_id uuid, p_inventory_item_id uuid, p_location_id uuid
) returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.inventory_movement_lines ml
    join public.inventory_movements m on m.id = ml.movement_id
   where m.organization_id = p_organization_id
     and m.location_id = p_location_id
     and ml.inventory_item_id = p_inventory_item_id
     and (
       m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
       or (m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
           and m.location_attribution = 'EXACT')
     );
$$;

revoke all on function public.inventory_location_item_ledger_line_count(uuid, uuid, uuid) from public;
grant execute on function public.inventory_location_item_ledger_line_count(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 5. start_or_resume_cycle_count (Part 9, 24)
-- ============================================================
create function public.start_or_resume_cycle_count(
  p_location_id uuid,
  p_started_by_app_user_id uuid
) returns table (
  out_cycle_count_id uuid,
  out_status text,
  out_version integer,
  out_resumed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_cycle_count_id uuid;
  v_inserted boolean := false;
begin
  -- organization_id is NEVER trusted from the caller -- derived here from
  -- the acting app_user, exactly like every other authoritative RPC in
  -- this schema (record_inventory_withdrawal, record_inventory_
  -- withdrawal_batch, record_receipt).
  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_started_by_app_user_id and au.is_active;

  if not found then
    raise exception 'started_by_app_user_id % is not an active app user', p_started_by_app_user_id;
  end if;

  if not exists (
    select 1 from public.locations l
     where l.id = p_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible
  ) then
    raise exception 'location_id % is not an active, storage-eligible location in organization %', p_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  -- Upsert-or-fetch in one statement: races between two managers both
  -- pressing "Start Cycle Count" at the same instant resolve to exactly one
  -- DRAFT row (the partial unique index is the actual arbiter), never two.
  insert into public.inventory_cycle_counts (organization_id, location_id, started_by_app_user_id)
  values (v_org_id, p_location_id, p_started_by_app_user_id)
  on conflict (organization_id, location_id) where status = 'DRAFT' do nothing
  returning id into v_cycle_count_id;

  if v_cycle_count_id is not null then
    v_inserted := true;
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (v_org_id, p_started_by_app_user_id, 'CYCLE_COUNT_STARTED', 'inventory_cycle_count', v_cycle_count_id,
            jsonb_build_object('locationId', p_location_id));
  else
    select id into v_cycle_count_id
      from public.inventory_cycle_counts
     where organization_id = v_org_id and location_id = p_location_id and status = 'DRAFT';
  end if;

  return query
    select c.id, c.status, c.version, not v_inserted
      from public.inventory_cycle_counts c
     where c.id = v_cycle_count_id;
end;
$$;

revoke all on function public.start_or_resume_cycle_count(uuid, uuid) from public;
grant execute on function public.start_or_resume_cycle_count(uuid, uuid) to service_role;

-- ============================================================
-- 6. add_cycle_count_line (Part 10, 28)
-- ============================================================
create function public.add_cycle_count_line(
  p_cycle_count_id uuid,
  p_inventory_item_id uuid,
  p_actor_app_user_id uuid
) returns table (
  out_line_id uuid,
  out_expected_quantity_at_snapshot numeric,
  out_base_unit_id uuid,
  out_physical_count_quantity numeric,
  out_already_existed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_status text;
  v_base_unit_id uuid;
  v_expected numeric;
  v_watermark integer;
  v_line_id uuid;
  v_inserted boolean := false;
begin
  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_actor_app_user_id and au.is_active;

  if not found then
    raise exception 'actor_app_user_id % is not an active app user', p_actor_app_user_id;
  end if;

  select location_id, status into v_location_id, v_status
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'cycle_count_id % is % and is not open for counting', p_cycle_count_id, v_status
      using errcode = 'GA003';
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = v_org_id and status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id;
  end if;

  v_expected := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, v_location_id);
  v_watermark := public.inventory_location_item_ledger_line_count(v_org_id, p_inventory_item_id, v_location_id);

  insert into public.inventory_cycle_count_lines (
    cycle_count_id, organization_id, inventory_item_id, base_unit_id,
    expected_quantity_at_snapshot, ledger_line_count_at_snapshot
  ) values (
    p_cycle_count_id, v_org_id, p_inventory_item_id, v_base_unit_id,
    v_expected, v_watermark
  )
  on conflict (cycle_count_id, inventory_item_id) do nothing
  returning id into v_line_id;

  if v_line_id is not null then
    v_inserted := true;
  end if;

  -- Already existed (Part 28: "focus/scroll to existing row rather than
  -- adding another") -- return its CURRENT state, not the snapshot we just
  -- (unused) computed above.
  return query
    select l.id, l.expected_quantity_at_snapshot, l.base_unit_id, l.physical_count_quantity, not v_inserted
      from public.inventory_cycle_count_lines l
     where l.cycle_count_id = p_cycle_count_id and l.inventory_item_id = p_inventory_item_id;
end;
$$;

revoke all on function public.add_cycle_count_line(uuid, uuid, uuid) from public;
grant execute on function public.add_cycle_count_line(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 7. record_cycle_count_line_observation (Part 5, 7, 13, 27)
-- ============================================================
-- p_physical_count_quantity null clears the line back to "not counted, no
-- change" (Part 27's blank/0 distinction enforced server-side too, not
-- only client-side). p_refresh_snapshot is ONLY true for the "Recount
-- Items" flow after a stale finalize response (Part 13) -- an ordinary
-- entry/edit while still actively counting deliberately leaves the
-- add-time snapshot untouched (Part 10).
create function public.record_cycle_count_line_observation(
  p_cycle_count_id uuid,
  p_inventory_item_id uuid,
  p_physical_count_quantity numeric,
  p_actor_app_user_id uuid,
  p_refresh_snapshot boolean default false
) returns table (
  out_line_id uuid,
  out_expected_quantity_at_snapshot numeric,
  out_physical_count_quantity numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_status text;
  v_line_id uuid;
begin
  if p_physical_count_quantity is not null and p_physical_count_quantity < 0 then
    raise exception 'physical_count_quantity must not be negative';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_actor_app_user_id and au.is_active;

  if not found then
    raise exception 'actor_app_user_id % is not an active app user', p_actor_app_user_id;
  end if;

  select location_id, status into v_location_id, v_status
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'cycle_count_id % is % and is not open for counting', p_cycle_count_id, v_status
      using errcode = 'GA003';
  end if;

  select id into v_line_id
    from public.inventory_cycle_count_lines
   where cycle_count_id = p_cycle_count_id and inventory_item_id = p_inventory_item_id;

  if not found then
    raise exception 'inventory_item_id % has not been added to cycle_count_id % yet', p_inventory_item_id, p_cycle_count_id;
  end if;

  if p_refresh_snapshot then
    update public.inventory_cycle_count_lines
       set expected_quantity_at_snapshot = public.inventory_location_item_balance(v_org_id, p_inventory_item_id, v_location_id),
           ledger_line_count_at_snapshot = public.inventory_location_item_ledger_line_count(v_org_id, p_inventory_item_id, v_location_id),
           physical_count_quantity = p_physical_count_quantity,
           counted_by_app_user_id = case when p_physical_count_quantity is null then null else p_actor_app_user_id end,
           counted_at = case when p_physical_count_quantity is null then null else now() end
     where id = v_line_id;
  else
    update public.inventory_cycle_count_lines
       set physical_count_quantity = p_physical_count_quantity,
           counted_by_app_user_id = case when p_physical_count_quantity is null then null else p_actor_app_user_id end,
           counted_at = case when p_physical_count_quantity is null then null else now() end
     where id = v_line_id;
  end if;

  return query
    select l.id, l.expected_quantity_at_snapshot, l.physical_count_quantity
      from public.inventory_cycle_count_lines l
     where l.id = v_line_id;
end;
$$;

revoke all on function public.record_cycle_count_line_observation(uuid, uuid, numeric, uuid, boolean) from public;
grant execute on function public.record_cycle_count_line_observation(uuid, uuid, numeric, uuid, boolean) to service_role;

-- ============================================================
-- 8. complete_cycle_count (Part 12-18) -- lock, recheck, reconcile,
--    atomically, or roll back entirely.
-- ============================================================
create function public.complete_cycle_count(
  p_cycle_count_id uuid,
  p_expected_version integer,
  p_completed_by_app_user_id uuid
) returns table (
  out_cycle_count_id uuid,
  out_in_movement_id uuid,
  out_out_movement_id uuid,
  out_counted_line_count integer,
  out_variance_line_count integer,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_location_id uuid;
  v_status text;
  v_version integer;
  v_timezone text;
  v_business_date date;
  v_lock_key bigint;
  v_stale jsonb;
  v_in_movement_id uuid;
  v_out_movement_id uuid;
  v_counted_count integer;
  v_variance_count integer;
begin
  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_completed_by_app_user_id and au.is_active;

  if not found then
    raise exception 'completed_by_app_user_id % is not an active app user', p_completed_by_app_user_id;
  end if;

  -- Row-locks THIS cycle count for the remainder of the transaction: a
  -- second, genuinely concurrent complete_cycle_count (or cancel_cycle_
  -- count) call for the SAME id blocks here until this one commits or
  -- rolls back, then observes whatever status this one left behind --
  -- which is exactly what makes "concurrent finalization cannot double-
  -- adjust" (Part 35 test 22) true by construction, not by luck.
  select location_id, status, version into v_location_id, v_status, v_version
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  -- Idempotent replay (Part 18): a completed count's result never changes
  -- again, so re-fetching it (whether from a genuine client retry or from
  -- having just blocked behind a concurrent finalize that won the race
  -- above) is always safe and never re-derives or re-inserts anything.
  if v_status = 'COMPLETED' then
    select id into v_in_movement_id from public.inventory_movements
     where cycle_count_id = p_cycle_count_id and movement_type = 'COUNT_ADJUSTMENT_IN';
    select id into v_out_movement_id from public.inventory_movements
     where cycle_count_id = p_cycle_count_id and movement_type = 'COUNT_ADJUSTMENT_OUT';
    select count(*) into v_counted_count from public.inventory_cycle_count_lines l
     where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null;
    select count(*) into v_variance_count from public.inventory_movement_lines ml
      join public.inventory_movements im on im.id = ml.movement_id
     where im.cycle_count_id = p_cycle_count_id;

    return query select p_cycle_count_id, v_in_movement_id, v_out_movement_id, v_counted_count, v_variance_count, true;
    return;
  end if;

  if v_status = 'CANCELLED' then
    raise exception 'cycle_count_id % is cancelled and cannot be completed', p_cycle_count_id
      using errcode = 'GA003';
  end if;

  if v_version <> p_expected_version then
    raise exception 'cycle_count_id % version conflict: expected %, actual %', p_cycle_count_id, p_expected_version, v_version
      using errcode = 'GA003';
  end if;

  select timezone into v_timezone
    from public.locations l
   where l.id = v_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible;

  if not found then
    raise exception 'location_id % is no longer an active, storage-eligible location', v_location_id
      using errcode = 'GA021';
  end if;

  v_business_date := (now() at time zone v_timezone)::date;

  -- Deterministic, globally-consistent lock acquisition (Part 12 step 4-5)
  -- -- every DISTINCT item among EXPLICITLY counted lines, sorted ascending
  -- by the SAME shared inventory_location_lock_key(...) every other
  -- availability-sensitive RPC uses. This is what serializes finalize
  -- against a concurrent kiosk withdrawal or receipt touching the same
  -- item/location, and (combined with the row lock above) against another
  -- finalize attempt.
  for v_lock_key in
    select distinct public.inventory_location_lock_key(v_org_id, l.inventory_item_id, v_location_id)
      from public.inventory_cycle_count_lines l
     where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  -- Authoritative re-check, now that every relevant write lock is held:
  -- ANY explicitly counted line whose ledger watermark has moved since its
  -- snapshot is stale (Part 12 step 8 / Part 13) -- collect ALL of them,
  -- not just the first, and commit ZERO adjustments for the whole session.
  select jsonb_agg(jsonb_build_object(
           'inventoryItemId', x.inventory_item_id,
           'locationId', v_location_id,
           'snapshotExpectedQuantity', x.snapshot_expected,
           'currentExpectedQuantity', x.current_expected,
           'physicalCountQuantity', x.physical_count_quantity,
           'stale', true
         ))
    into v_stale
    from (
      select l.inventory_item_id, l.expected_quantity_at_snapshot as snapshot_expected,
             public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id) as current_expected,
             l.physical_count_quantity
        from public.inventory_cycle_count_lines l
       where l.cycle_count_id = p_cycle_count_id
         and l.physical_count_quantity is not null
         and public.inventory_location_item_ledger_line_count(v_org_id, l.inventory_item_id, v_location_id)
             <> l.ledger_line_count_at_snapshot
    ) x;

  if v_stale is not null then
    raise exception 'one or more counted lines changed since they were counted and must be recounted'
      using errcode = 'GA023', detail = v_stale::text;
  end if;

  select count(*) into v_counted_count
    from public.inventory_cycle_count_lines l
   where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null;

  -- One COUNT_ADJUSTMENT_IN movement for every positive-variance line at
  -- this location (Part 16) -- at most one, regardless of how many items
  -- vary upward. Zero-variance lines never produce a movement, but remain
  -- in inventory_cycle_count_lines as completed physical-reconciliation
  -- facts (Part 15, 31) -- nothing here deletes or skips writing them;
  -- they simply already exist from add_cycle_count_line/record_cycle_
  -- count_line_observation and need no further action.
  insert into public.inventory_movements (
    organization_id, location_id, station_id, movement_type,
    performed_by_app_user_id, business_date, location_attribution, cycle_count_id
  )
  select v_org_id, v_location_id, null, 'COUNT_ADJUSTMENT_IN',
         p_completed_by_app_user_id, v_business_date, 'EXACT', p_cycle_count_id
   where exists (
     select 1 from public.inventory_cycle_count_lines l
      where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
        and l.physical_count_quantity > public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id)
   )
  returning id into v_in_movement_id;

  insert into public.inventory_movements (
    organization_id, location_id, station_id, movement_type,
    performed_by_app_user_id, business_date, location_attribution, cycle_count_id
  )
  select v_org_id, v_location_id, null, 'COUNT_ADJUSTMENT_OUT',
         p_completed_by_app_user_id, v_business_date, 'EXACT', p_cycle_count_id
   where exists (
     select 1 from public.inventory_cycle_count_lines l
      where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
        and l.physical_count_quantity < public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id)
   )
  returning id into v_out_movement_id;

  -- entered_unit_id = the item's own base unit, at the always-1:1 identity
  -- conversion every withdrawable item's master data already guarantees
  -- (same DATA CONVENTION app/lib/kiosk/withdrawalUnit.ts documents and
  -- relies on) -- enforce_movement_line_measurement() computes
  -- normalized_base_quantity = entered_quantity here, so the movement
  -- line's quantity is exactly the variance magnitude, in base units,
  -- with no separate conversion step to get wrong.
  insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id, cycle_count_line_id)
  select v_in_movement_id, l.inventory_item_id,
         l.physical_count_quantity - public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id),
         l.base_unit_id, l.id
    from public.inventory_cycle_count_lines l
   where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
     and l.physical_count_quantity > public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id);

  insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id, cycle_count_line_id)
  select v_out_movement_id, l.inventory_item_id,
         public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id) - l.physical_count_quantity,
         l.base_unit_id, l.id
    from public.inventory_cycle_count_lines l
   where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
     and l.physical_count_quantity < public.inventory_location_item_balance(v_org_id, l.inventory_item_id, v_location_id);

  select count(*) into v_variance_count
    from public.inventory_movement_lines ml
    join public.inventory_movements im on im.id = ml.movement_id
   where im.cycle_count_id = p_cycle_count_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    v_org_id, p_completed_by_app_user_id, 'CYCLE_COUNT_COMPLETED', 'inventory_cycle_count', p_cycle_count_id,
    jsonb_build_object(
      'locationId', v_location_id,
      'countedLineCount', v_counted_count,
      'varianceLineCount', v_variance_count,
      'inMovementId', v_in_movement_id,
      'outMovementId', v_out_movement_id
    )
  );

  -- The version predicate here is defensive, not the primary guard (the
  -- row lock acquired at the top of this function already holds this row
  -- exclusively for the whole transaction) -- kept for the same reason
  -- purchase_documents' RPCs keep expected_version on every transition,
  -- consistent house style for terminal-status changes.
  update public.inventory_cycle_counts
     set status = 'COMPLETED', completed_by_app_user_id = p_completed_by_app_user_id, completed_at = now(), version = version + 1
   where id = p_cycle_count_id and version = p_expected_version;

  return query select p_cycle_count_id, v_in_movement_id, v_out_movement_id, v_counted_count, v_variance_count, false;
end;
$$;

revoke all on function public.complete_cycle_count(uuid, integer, uuid) from public;
grant execute on function public.complete_cycle_count(uuid, integer, uuid) to service_role;

-- ============================================================
-- 9. cancel_cycle_count (Part 32)
-- ============================================================
create function public.cancel_cycle_count(
  p_cycle_count_id uuid,
  p_expected_version integer,
  p_cancelled_by_app_user_id uuid,
  p_reason text
) returns table (
  out_cycle_count_id uuid,
  out_status text,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_status text;
  v_version integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a cancellation reason is required';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_cancelled_by_app_user_id and au.is_active;

  if not found then
    raise exception 'cancelled_by_app_user_id % is not an active app user', p_cancelled_by_app_user_id;
  end if;

  select status, version into v_status, v_version
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  if v_status = 'CANCELLED' then
    return query select p_cycle_count_id, 'CANCELLED'::text, true;
    return;
  end if;

  if v_status = 'COMPLETED' then
    raise exception 'cycle_count_id % is completed and cannot be cancelled', p_cycle_count_id
      using errcode = 'GA003';
  end if;

  if v_version <> p_expected_version then
    raise exception 'cycle_count_id % version conflict: expected %, actual %', p_cycle_count_id, p_expected_version, v_version
      using errcode = 'GA003';
  end if;

  update public.inventory_cycle_counts
     set status = 'CANCELLED', cancelled_by_app_user_id = p_cancelled_by_app_user_id, cancelled_at = now(),
         cancellation_reason = p_reason, version = version + 1
   where id = p_cycle_count_id and version = p_expected_version;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (v_org_id, p_cancelled_by_app_user_id, 'CYCLE_COUNT_CANCELLED', 'inventory_cycle_count', p_cycle_count_id,
          jsonb_build_object('reason', p_reason));

  return query select p_cycle_count_id, 'CANCELLED'::text, false;
end;
$$;

revoke all on function public.cancel_cycle_count(uuid, integer, uuid, text) from public;
grant execute on function public.cancel_cycle_count(uuid, integer, uuid, text) to service_role;

-- ============================================================
-- 10. Legacy-estimate reconciliation (Part 19) -- a completed physical
--     count (including a zero-variance one) clears includes_legacy_
--     estimate for that exact (item, location) going forward, WITHOUT
--     ever touching inventory_legacy_location_allocations itself (still
--     frozen forever, per 20260811100073). Scoped per (item, location) --
--     a count at one location never clears legacy status for a sibling
--     location, and counting one item never affects another.
-- ============================================================
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
      and not exists (
        select 1
          from public.inventory_cycle_count_lines l
          join public.inventory_cycle_counts c on c.id = l.cycle_count_id
         where c.organization_id = p_organization_id
           and c.status = 'COMPLETED'
           and c.location_id = b.out_location_id
           and l.inventory_item_id = b.out_inventory_item_id
           and l.physical_count_quantity is not null
      )
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
