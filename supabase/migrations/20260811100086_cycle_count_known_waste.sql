-- Cycle Count integration with Inventory Waste, Phase E: provisional
-- "known waste found during counting" marking, and the completion guard
-- that blocks finishing a count while identified waste is unresolved.
--
-- Purely additive on top of 20260811100081-100085. Deliberately the
-- SMALLEST structure that satisfies the product requirement (Part 37):
-- reason/note are NOT stored provisionally at all -- the manager chooses
-- them only at Review time, as direct parameters to the (Phase F)
-- record_cycle_count_line_waste operation, never duplicated onto the
-- line itself. The line only ever needs to remember: was known waste
-- identified, how much, and (once actually posted) which waste event
-- resolved it.
--
-- ============================================================
-- 1. inventory_cycle_count_lines -- provisional known-waste fields.
-- ============================================================
alter table public.inventory_cycle_count_lines
  add column identified_waste_quantity numeric,
  add column waste_event_id uuid,
  add column waste_resolved_at timestamptz;

alter table public.inventory_cycle_count_lines
  add constraint inventory_cycle_count_lines_identified_waste_qty_check
    check (identified_waste_quantity is null or identified_waste_quantity > 0);

-- waste_event_id and waste_resolved_at are set together, atomically, by
-- record_cycle_count_line_waste (Phase F) -- never one without the other.
alter table public.inventory_cycle_count_lines
  add constraint inventory_cycle_count_lines_waste_resolved_consistency_check
    check ((waste_event_id is null) = (waste_resolved_at is null));

-- Waste can only be RESOLVED for a line that was actually IDENTIFIED as
-- having known waste -- resolving a line no one ever flagged is not a
-- reachable, meaningful state.
alter table public.inventory_cycle_count_lines
  add constraint inventory_cycle_count_lines_waste_requires_identified_check
    check (waste_event_id is null or identified_waste_quantity is not null);

alter table public.inventory_cycle_count_lines
  add constraint inventory_cycle_count_lines_waste_event_org_fk
    foreign key (waste_event_id, organization_id)
    references public.inventory_waste_events (id, organization_id);

create index inventory_cycle_count_lines_unresolved_waste_idx
  on public.inventory_cycle_count_lines (cycle_count_id)
  where identified_waste_quantity is not null and waste_event_id is null;

-- ============================================================
-- 2. mark_cycle_count_line_known_waste -- provisional marker only (Part
--    22/23). Never touches the ledger, never creates inventory_waste_
--    events or a WASTE movement -- that only happens later, from Review,
--    via the dedicated record_cycle_count_line_waste operation (Phase
--    F). The manager can flag/unflag/adjust the identified quantity
--    freely while still counting, exactly like any other DRAFT edit.
-- ============================================================
create function public.mark_cycle_count_line_known_waste(
  p_cycle_count_id uuid,
  p_inventory_item_id uuid,
  p_identified_waste_quantity numeric,
  p_actor_app_user_id uuid
) returns table (
  out_line_id uuid,
  out_identified_waste_quantity numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_status text;
  v_owner uuid;
  v_line_id uuid;
  v_expected numeric;
  v_physical numeric;
  v_existing_waste_event_id uuid;
  v_max_waste numeric;
begin
  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_actor_app_user_id and au.is_active;

  if not found then
    raise exception 'actor_app_user_id % is not an active app user', p_actor_app_user_id;
  end if;

  select status, started_by_app_user_id into v_status, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'cycle_count_id % is % and is not open for counting', p_cycle_count_id, v_status
      using errcode = 'GA003';
  end if;

  -- Same DRAFT-ownership rule as every other mutating cycle-count RPC
  -- (20260811100082) -- only the manager who started this count may flag
  -- known waste on it.
  if v_owner is distinct from p_actor_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
  end if;

  select id, expected_quantity_at_snapshot, physical_count_quantity, waste_event_id
    into v_line_id, v_expected, v_physical, v_existing_waste_event_id
    from public.inventory_cycle_count_lines
   where cycle_count_id = p_cycle_count_id and inventory_item_id = p_inventory_item_id;

  if not found then
    raise exception 'inventory_item_id % has not been added to cycle_count_id % yet', p_inventory_item_id, p_cycle_count_id;
  end if;

  if v_existing_waste_event_id is not null then
    raise exception 'cycle_count_line % already has recorded waste and cannot be re-flagged', v_line_id
      using errcode = 'GA031';
  end if;

  -- A manager can only flag known waste against an item they have
  -- ALREADY physically counted (Part 22's own example always shows the
  -- Physical Count already entered before the checkbox appears) -- there
  -- is no variance to explain otherwise.
  if v_physical is null then
    raise exception 'cycle_count_line % must be physically counted before known waste can be flagged', v_line_id;
  end if;

  if p_identified_waste_quantity is null then
    -- Clearing a previous provisional flag (Part "clearing provisional
    -- waste before recording creates no movement") -- always legal while
    -- unresolved, since nothing has been posted yet.
    update public.inventory_cycle_count_lines
       set identified_waste_quantity = null
     where id = v_line_id;

    return query select v_line_id, null::numeric;
    return;
  end if;

  if p_identified_waste_quantity <= 0 then
    raise exception 'identified waste quantity must be greater than zero'
      using errcode = 'GA026';
  end if;

  -- Only negative variance can be explained as outgoing waste (Part 30):
  -- identified waste quantity must not exceed the absolute negative
  -- variance AT THE TIME OF THIS COUNT SNAPSHOT. A zero/positive variance
  -- line can never be marked.
  v_max_waste := v_expected - v_physical;
  if v_max_waste <= 0 or p_identified_waste_quantity > v_max_waste then
    raise exception 'identified waste quantity % exceeds the negative variance % for cycle_count_line %',
      p_identified_waste_quantity, greatest(v_max_waste, 0), v_line_id
      using errcode = 'GA026';
  end if;

  update public.inventory_cycle_count_lines
     set identified_waste_quantity = p_identified_waste_quantity
   where id = v_line_id;

  return query select v_line_id, p_identified_waste_quantity;
end;
$$;

revoke all on function public.mark_cycle_count_line_known_waste(uuid, uuid, numeric, uuid) from public;
grant execute on function public.mark_cycle_count_line_known_waste(uuid, uuid, numeric, uuid) to service_role;

-- ============================================================
-- 3. complete_cycle_count -- completion guard (Part 31). Same 4-argument
--    signature as 20260811100084, so CREATE OR REPLACE is a true replace,
--    not a new overload. Every other line of this function is byte-for-
--    byte unchanged from 20260811100084 except for the new guard inserted
--    right after the version check and before the completion-note check
--    (Part 31 doesn't specify relative ordering against the note
--    requirement; "you still have unresolved known waste" is checked
--    first as the more fundamental blocker).
-- ============================================================
create or replace function public.complete_cycle_count(
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
  v_location_name text;
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
  v_unresolved_waste_count integer;
begin
  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_completed_by_app_user_id and au.is_active;

  if not found then
    raise exception 'completed_by_app_user_id % is not an active app user', p_completed_by_app_user_id;
  end if;

  select location_id, status, version, started_by_app_user_id into v_location_id, v_status, v_version, v_owner
    from public.inventory_cycle_counts
   where id = p_cycle_count_id and organization_id = v_org_id
     for update;

  if not found then
    raise exception 'cycle_count_id % not found in organization %', p_cycle_count_id, v_org_id;
  end if;

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

  if v_owner is distinct from p_completed_by_app_user_id then
    raise exception 'cycle_count_id % is owned by a different manager', p_cycle_count_id
      using errcode = 'GA024';
  end if;

  if v_version <> p_expected_version then
    raise exception 'cycle_count_id % version conflict: expected %, actual %', p_cycle_count_id, p_expected_version, v_version
      using errcode = 'GA003';
  end if;

  -- Completion guard (Part 31, 20260811100086): if ANY line still has
  -- known waste identified but not yet posted/resolved, completion is
  -- blocked. "Known waste must be recorded before this cycle count can
  -- be completed."
  select count(*) into v_unresolved_waste_count
    from public.inventory_cycle_count_lines l
   where l.cycle_count_id = p_cycle_count_id
     and l.identified_waste_quantity is not null
     and l.waste_event_id is null;

  if v_unresolved_waste_count > 0 then
    raise exception 'cycle_count_id % has % line(s) with known waste identified but not yet recorded', p_cycle_count_id, v_unresolved_waste_count
      using errcode = 'GA032';
  end if;

  if p_completion_note is null or btrim(p_completion_note) = '' then
    raise exception 'a completion note is required to complete a cycle count'
      using errcode = 'GA025';
  end if;

  select timezone, name into v_timezone, v_location_name
    from public.locations l
   where l.id = v_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible;

  if not found then
    raise exception 'location_id % is no longer an active, storage-eligible location', v_location_id
      using errcode = 'GA021';
  end if;

  v_business_date := (now() at time zone v_timezone)::date;

  for v_lock_key in
    select distinct public.inventory_location_lock_key(v_org_id, l.inventory_item_id, v_location_id)
      from public.inventory_cycle_count_lines l
     where l.cycle_count_id = p_cycle_count_id and l.physical_count_quantity is not null
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

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
     set status = 'COMPLETED', completed_by_app_user_id = p_completed_by_app_user_id, completed_at = now(), version = version + 1,
         completion_note = btrim(p_completion_note)
   where id = p_cycle_count_id and version = p_expected_version;

  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  )
  select v_org_id, recipient.app_user_id, 'CYCLE_COUNT_COMPLETED', 'inventory_cycle_count', p_cycle_count_id,
    format('Cycle count completed: %s', v_location_name),
    case
      when v_variance_count = 0 then format('%s items counted, no variances.', v_counted_count)
      else format('%s items counted, %s %s.', v_counted_count, v_variance_count, case when v_variance_count = 1 then 'variance' else 'variances' end)
    end,
    jsonb_build_object(
      'locationId', v_location_id,
      'countedLineCount', v_counted_count,
      'varianceLineCount', v_variance_count,
      'completedByAppUserId', p_completed_by_app_user_id
    )
  from (
    select distinct au.id as app_user_id
      from public.app_users au
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id
     where au.organization_id = v_org_id
       and au.is_active
       and r.name in ('manager', 'admin')
       and au.id <> p_completed_by_app_user_id
  ) recipient;

  return query select p_cycle_count_id, v_in_movement_id, v_out_movement_id, v_counted_count, v_variance_count, false;
end;
$$;

revoke all on function public.complete_cycle_count(uuid, integer, uuid, text) from public;
grant execute on function public.complete_cycle_count(uuid, integer, uuid, text) to service_role;
