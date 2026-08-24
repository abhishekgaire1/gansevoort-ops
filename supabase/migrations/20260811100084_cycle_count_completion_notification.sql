-- Cycle Count: notify every manager/admin in the organization when a
-- cycle count completes, so the crew that didn't do the count still finds
-- out about it (and any variance) without polling the hub.
--
-- Purely additive on top of 20260811100081/100082/100083 -- no schema
-- change. Reuses the existing, deliberately generic user_notifications
-- table (20260811100029) and its NotificationBell/listNotifications
-- read path exactly as-is; only complete_cycle_count itself changes,
-- via CREATE OR REPLACE (its parameter list is unchanged, so this is a
-- true replace, not a new overload).
--
-- ============================================================
-- WHAT'S NEW
-- ============================================================
--   - complete_cycle_count, after the completion UPDATE succeeds, inserts
--     one user_notifications row per ACTIVE manager/admin in the same
--     organization, EXCLUDING the manager who completed the count (they
--     already know). Recipients are resolved the same way requireManager
--     OrAdmin does client-side (user_roles -> roles.name in
--     ('manager','admin')), so every recipient is guaranteed to actually
--     have a notification bell that can display it.
--   - Because this insert happens AFTER the atomic completion UPDATE and
--     BEFORE the function's final RETURN, it is covered by the same
--     transaction as everything else complete_cycle_count does: a stale-
--     line rejection or any earlier failure still rolls back the whole
--     attempt, including notifications, exactly like the audit_events
--     insert already above it.
--   - The idempotent-replay branch (v_status = 'COMPLETED', near the top
--     of the function) returns BEFORE reaching this point, so replaying
--     an already-completed call never sends a second round of
--     notifications -- matching "replay never re-validates or re-writes
--     anything" already established for completion_note.
--   - NotificationBell's entityHref gains one case (inventory_cycle_count
--     -> /manager/inventory/cycle-count/:id) so the new notification type
--     is actually clickable, not a dead "#" link.
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
  -- already-stored completion_note -- and never sends a second round of
  -- completion notifications.
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

  select timezone, name into v_timezone, v_location_name
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

  -- Notify every OTHER active manager/admin in the org (20260811100084).
  -- Same role definition requireManagerOrAdmin uses client-side, so every
  -- recipient this creates a row for is guaranteed to have a notification
  -- bell that can actually show it. The completing manager is excluded --
  -- they already know they just completed it.
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
