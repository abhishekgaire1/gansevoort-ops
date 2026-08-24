-- Cycle Count: required completion note + an efficient history summary
-- query, for the Cycle Count hub/history manager workflow.
--
-- Purely additive on top of 20260811100081/20260811100082. Neither prior
-- migration is edited. complete_cycle_count's signature genuinely changes
-- (a new required parameter), so it is explicitly DROPPED and recreated
-- here rather than CREATE OR REPLACE'd -- Postgres treats a different
-- parameter list as a distinct overload, not a replacement, and leaving
-- the old 3-arg version reachable would silently bypass the new note
-- requirement. Every other existing RPC (add_cycle_count_line, record_
-- cycle_count_line_observation, cancel_cycle_count, start_or_resume_
-- cycle_count) is untouched -- this migration only touches completion.
--
-- ============================================================
-- WHAT'S NEW
-- ============================================================
--   - inventory_cycle_counts.completion_note: nullable text column,
--     required (non-null, non-blank-after-trim) at the DATABASE level the
--     moment status transitions to COMPLETED -- enforced by EXTENDING the
--     existing inventory_cycle_counts_forbid_locked_mutation() lifecycle
--     trigger (adding a BEFORE INSERT trigger alongside its existing
--     BEFORE UPDATE/DELETE ones), NOT by a CHECK constraint. A CHECK
--     constraint is validated against every existing row the instant it is
--     added, which is exactly what made the first attempt at this
--     migration fail: rows COMPLETED before this feature existed have
--     completion_note = NULL, and a retroactive CHECK has no way to
--     grandfather them. A BEFORE INSERT/UPDATE trigger only ever fires on
--     rows actually being written going forward, so historical rows are
--     never re-evaluated and remain valid, immutable history -- while any
--     NEW transition into COMPLETED (via complete_cycle_count, or via any
--     other direct write that bypassed it entirely) is rejected without a
--     non-blank note. Also validated at the application level inside
--     complete_cycle_count itself (which is what actually produces the
--     structured GA025 error the UI can show, since a bare trigger
--     exception has no friendly message) -- defense in depth. Immutable
--     once set, via the SAME trigger that already guards every other field
--     on this table.
--   - complete_cycle_count: gains p_completion_note text. Validated
--     AFTER ownership/version (so a non-owner or version-conflict caller
--     gets that specific reason, not a note complaint) but BEFORE the
--     location check, lock acquisition, and staleness re-check -- and
--     because the whole function body is one transaction, a stale-line
--     rejection later still rolls back everything, including the note:
--     there is no path where a rejected completion attempt leaves a note
--     behind on a DRAFT count.
--   - list_cycle_count_summaries: ONE query returning aggregated summary
--     rows (location, status, started/completed/cancelled by + when,
--     completion_note/cancellation_reason, countedItemCount,
--     varianceItemCount) for a set of statuses -- serves BOTH the hub's
--     "in progress" section (p_statuses = ARRAY['DRAFT']) and its history
--     section (p_statuses defaults to COMPLETED+CANCELLED), never one
--     query per row. varianceItemCount reuses expected_quantity_at_
--     snapshot (the frozen, already-verified-non-stale value at
--     completion time -- never re-read live), matching complete_cycle_
--     count's own variance definition exactly.

-- ============================================================
-- 1. completion_note column + lifecycle-trigger enforcement
-- ============================================================
-- Purely additive column -- existing rows get completion_note = NULL,
-- which is exactly what "grandfathered" means here: a historical COMPLETED
-- row with no note stays valid and stays untouched by this migration.
alter table public.inventory_cycle_counts add column completion_note text;

-- inventory_cycle_counts_completed_fields_check (from 20260811100081) is
-- deliberately left untouched -- it only requires completed_by_app_user_id
-- and completed_at, which every existing COMPLETED row already satisfies.
-- The completion_note requirement is NOT added to it (a CHECK constraint
-- cannot distinguish "old row" from "new row" and would fail exactly as
-- this migration did on its first attempt); it is enforced below instead,
-- by extending the existing forbid_locked_mutation trigger to validate
-- ONLY the row actually being written, never the table's existing
-- contents.
create or replace function public.inventory_cycle_counts_forbid_locked_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_cycle_count % may never be deleted', old.id
      using errcode = 'GA003';
  end if;

  if tg_op = 'UPDATE' and old.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'inventory_cycle_count % is % and cannot be modified', old.id, old.status
      using errcode = 'GA003';
  end if;

  -- Required-completion-note lifecycle validation (20260811100083): fires
  -- for ANY row landing on status = 'COMPLETED' via INSERT or UPDATE,
  -- regardless of caller -- complete_cycle_count, or any other direct
  -- write that bypasses it entirely. Because this is a trigger, it only
  -- ever evaluates the row being written right now; it never scans or
  -- re-validates rows that were already COMPLETED before this migration,
  -- which is what lets historical NULL-note completions remain valid
  -- history instead of being retroactively invalidated.
  if new.status = 'COMPLETED' then
    if new.completed_by_app_user_id is null or new.completed_at is null then
      raise exception 'inventory_cycle_count % cannot become COMPLETED without completed_by_app_user_id and completed_at', new.id
        using errcode = 'GA003';
    end if;
    if new.completion_note is null or btrim(new.completion_note) = '' then
      raise exception 'inventory_cycle_count % cannot become COMPLETED without a non-empty completion note', new.id
        using errcode = 'GA025';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- BEFORE UPDATE and BEFORE DELETE triggers already exist (20260811100081)
-- and are automatically rebound to the redefined function body above --
-- CREATE OR REPLACE FUNCTION does not require recreating the triggers
-- that reference it. Only the BEFORE INSERT trigger is new, closing the
-- one remaining gap (a direct INSERT with status = 'COMPLETED').
create trigger inventory_cycle_counts_forbid_locked_insert
  before insert on public.inventory_cycle_counts
  for each row execute function public.inventory_cycle_counts_forbid_locked_mutation();

-- ============================================================
-- 2. complete_cycle_count -- required completion note
-- ============================================================
drop function if exists public.complete_cycle_count(uuid, integer, uuid);

create function public.complete_cycle_count(
  p_cycle_count_id uuid,
  p_expected_version integer,
  p_completed_by_app_user_id uuid,
  p_completion_note text
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
  v_owner uuid;
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
  -- adjust" true by construction, not by luck.
  select location_id, status, version, started_by_app_user_id into v_location_id, v_status, v_version, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  -- Idempotent replay (Part 18 from the original design): a completed
  -- count's result never changes again, so re-fetching it (whether from a
  -- genuine client retry or from having just blocked behind a concurrent
  -- finalize that won the race above) is always safe and never re-derives
  -- or re-inserts anything, and never re-validates or overwrites the
  -- already-stored completion_note.
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

  -- Ownership gate -- only reached for a still-DRAFT count. Checked BEFORE
  -- the version and note checks so a non-owner gets the specific "not
  -- yours" reason rather than a generic conflict or note complaint.
  if v_owner is distinct from p_completed_by_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
  end if;

  if v_version <> p_expected_version then
    raise exception 'cycle_count_id % version conflict: expected %, actual %', p_cycle_count_id, p_expected_version, v_version
      using errcode = 'GA003';
  end if;

  -- Required completion note (Part "REQUIRED COMPLETION NOTE") -- checked
  -- before any lock is acquired or any ledger row is touched. Because this
  -- whole function body is one transaction, a LATER rejection (stale
  -- lines, below) still rolls back everything, so there is no path where
  -- a note is persisted without every other completion guarantee also
  -- having held.
  if p_completion_note is null or btrim(p_completion_note) = '' then
    raise exception 'a completion note is required to complete a cycle count'
      using errcode = 'GA025';
  end if;

  select timezone into v_timezone
    from public.locations l
   where l.id = v_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible;

  if not found then
    raise exception 'location_id % is no longer an active, storage-eligible location', v_location_id
      using errcode = 'GA021';
  end if;

  v_business_date := (now() at time zone v_timezone)::date;

  -- Deterministic, globally-consistent lock acquisition -- every DISTINCT
  -- item among EXPLICITLY counted lines, sorted ascending by the SAME
  -- shared inventory_location_lock_key(...) every other availability-
  -- sensitive RPC uses. This is what serializes finalize against a
  -- concurrent kiosk withdrawal or receipt touching the same
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
  -- snapshot is stale -- collect ALL of them, not just the first, and
  -- commit ZERO adjustments (and no completion_note) for the whole
  -- session.
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

  -- Structured index into the ledger only -- never the freeform note
  -- (Part "AUDIT": "Do not dump the full freeform completion note into
  -- noisy audit metadata"). The canonical note lives on inventory_cycle_
  -- counts.completion_note.
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

  update public.inventory_cycle_counts
     set status = 'COMPLETED', completed_by_app_user_id = p_completed_by_app_user_id, completed_at = now(), version = version + 1,
         completion_note = btrim(p_completion_note)
   where id = p_cycle_count_id and version = p_expected_version;

  return query select p_cycle_count_id, v_in_movement_id, v_out_movement_id, v_counted_count, v_variance_count, false;
end;
$$;

revoke all on function public.complete_cycle_count(uuid, integer, uuid, text) from public;
grant execute on function public.complete_cycle_count(uuid, integer, uuid, text) to service_role;

-- ============================================================
-- 3. list_cycle_count_summaries -- ONE query, no N+1, serves both the
--    hub's "in progress" section and its history section.
-- ============================================================
create function public.list_cycle_count_summaries(
  p_organization_id uuid,
  p_statuses text[] default array['COMPLETED', 'CANCELLED'],
  p_location_id uuid default null,
  p_limit integer default 50
) returns table (
  out_cycle_count_id uuid,
  out_location_id uuid,
  out_location_name text,
  out_status text,
  out_version integer,
  out_started_by_app_user_id uuid,
  out_started_at timestamptz,
  out_completed_by_app_user_id uuid,
  out_completed_at timestamptz,
  out_cancelled_by_app_user_id uuid,
  out_cancelled_at timestamptz,
  out_cancellation_reason text,
  out_completion_note text,
  out_counted_item_count integer,
  out_variance_item_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.location_id,
    loc.name,
    c.status,
    c.version,
    c.started_by_app_user_id,
    c.started_at,
    c.completed_by_app_user_id,
    c.completed_at,
    c.cancelled_by_app_user_id,
    c.cancelled_at,
    c.cancellation_reason,
    c.completion_note,
    coalesce(lc.counted_item_count, 0)::integer,
    coalesce(lc.variance_item_count, 0)::integer
  from public.inventory_cycle_counts c
  join public.locations loc on loc.id = c.location_id
  left join lateral (
    -- Same variance definition complete_cycle_count itself uses: a
    -- counted line's FROZEN snapshot (never a live re-read -- for a
    -- COMPLETED count that snapshot was already verified non-stale at
    -- completion time; for a DRAFT/CANCELLED count there is no
    -- authoritative completion-time balance to compare against anyway).
    select count(*) filter (where l.physical_count_quantity is not null) as counted_item_count,
           count(*) filter (
             where l.physical_count_quantity is not null
               and l.physical_count_quantity <> l.expected_quantity_at_snapshot
           ) as variance_item_count
      from public.inventory_cycle_count_lines l
     where l.cycle_count_id = c.id
  ) lc on true
  where c.organization_id = p_organization_id
    and c.status = any(p_statuses)
    and (p_location_id is null or c.location_id = p_location_id)
  order by coalesce(c.completed_at, c.cancelled_at, c.started_at) desc
  limit p_limit;
$$;

revoke all on function public.list_cycle_count_summaries(uuid, text[], uuid, integer) from public;
grant execute on function public.list_cycle_count_summaries(uuid, text[], uuid, integer) to service_role;
