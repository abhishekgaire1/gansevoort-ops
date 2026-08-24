-- Cycle Count DRAFT ownership -- only the manager who started a DRAFT
-- cycle count (inventory_cycle_counts.started_by_app_user_id) may resume,
-- add items to, record observations on, refresh a stale snapshot for,
-- complete, or cancel it. A different manager in the SAME organization
-- must be rejected server-side, not merely hidden by the UI.
--
-- Purely additive on top of 20260811100081_cycle_counts.sql: every
-- function below is CREATE OR REPLACE with an UNCHANGED signature/return
-- shape, so no drop-and-recreate is needed and every existing TS call site
-- keeps working unmodified except for the new rejection path. No table,
-- column, or index changes.
--
-- New GA024 = CYCLE_COUNT_OWNED_BY_ANOTHER_MANAGER, continuing the GA0xx
-- sequence (GA023 was the previous migration's stale-cycle-count-line
-- code). Scoped narrowly to the DRAFT window, per the design: once a count
-- is COMPLETED or CANCELLED it is already immutable to EVERYONE regardless
-- of caller (20260811100081's forbid_locked_mutation trigger + each RPC's
-- own status checks already guarantee that) -- a non-owner replaying an
-- already-terminal count's stored result is a harmless read, not a
-- mutation, so it is deliberately NOT blocked by this ownership check.
--
-- start_or_resume_cycle_count keeps its existing atomic "INSERT ... ON
-- CONFLICT DO NOTHING, else SELECT the existing DRAFT" shape (the ONLY
-- thing that makes the required two-manager race deterministic: exactly
-- one INSERT can ever win the partial unique index, full stop) and adds
-- exactly one new branch to the "someone already beat me to it" fallback:
-- if that existing DRAFT's owner isn't the caller, raise GA024 instead of
-- silently returning it as resumable.

create or replace function public.start_or_resume_cycle_count(
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
  v_existing_owner uuid;
  v_inserted boolean := false;
begin
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
    select id, started_by_app_user_id into v_cycle_count_id, v_existing_owner
      from public.inventory_cycle_counts
     where organization_id = v_org_id and location_id = p_location_id and status = 'DRAFT';

    -- The insert lost the race to an existing DRAFT -- if it belongs to a
    -- DIFFERENT manager, this caller gets rejected, not a resumable
    -- result (Part "START RPC SEMANTICS"). No second DRAFT was created
    -- either way -- the ON CONFLICT above already guaranteed that.
    if v_existing_owner is distinct from p_started_by_app_user_id then
      raise exception 'cycle count at location % is already in progress, started by a different manager', p_location_id
        using errcode = 'GA024';
    end if;
  end if;

  return query
    select c.id, c.status, c.version, not v_inserted
      from public.inventory_cycle_counts c
     where c.id = v_cycle_count_id;
end;
$$;

create or replace function public.add_cycle_count_line(
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
  v_owner uuid;
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

  select location_id, status, started_by_app_user_id into v_location_id, v_status, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  if v_owner is distinct from p_actor_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
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

  return query
    select l.id, l.expected_quantity_at_snapshot, l.base_unit_id, l.physical_count_quantity, not v_inserted
      from public.inventory_cycle_count_lines l
     where l.cycle_count_id = p_cycle_count_id and l.inventory_item_id = p_inventory_item_id;
end;
$$;

create or replace function public.record_cycle_count_line_observation(
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
  v_owner uuid;
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

  select location_id, status, started_by_app_user_id into v_location_id, v_status, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  if v_owner is distinct from p_actor_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
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

create or replace function public.complete_cycle_count(
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

  -- Idempotent replay (Part 18): a completed count's result never changes
  -- again, so re-fetching it (whether from a genuine client retry or from
  -- having just blocked behind a concurrent finalize that won the race
  -- above) is always safe and never re-derives or re-inserts anything.
  -- Deliberately NOT gated on ownership -- a completed count is already
  -- immutable to everyone, and reading back its stored result is harmless
  -- regardless of who asks.
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

  -- Ownership gate -- only reached for a still-DRAFT count (Part "Only the
  -- owner may complete or cancel the DRAFT"). Checked BEFORE the version
  -- check so a non-owner gets the specific "not yours" reason rather than
  -- a generic conflict.
  if v_owner is distinct from p_completed_by_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
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
  -- commit ZERO adjustments for the whole session.
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
     set status = 'COMPLETED', completed_by_app_user_id = p_completed_by_app_user_id, completed_at = now(), version = version + 1
   where id = p_cycle_count_id and version = p_expected_version;

  return query select p_cycle_count_id, v_in_movement_id, v_out_movement_id, v_counted_count, v_variance_count, false;
end;
$$;

create or replace function public.cancel_cycle_count(
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
  v_owner uuid;
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

  select status, version, started_by_app_user_id into v_status, v_version, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

  -- Deliberately NOT gated on ownership -- see complete_cycle_count's
  -- identical replay comment.
  if v_status = 'CANCELLED' then
    return query select p_cycle_count_id, 'CANCELLED'::text, true;
    return;
  end if;

  if v_status = 'COMPLETED' then
    raise exception 'cycle_count_id % is completed and cannot be cancelled', p_cycle_count_id
      using errcode = 'GA003';
  end if;

  if v_owner is distinct from p_cancelled_by_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
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
