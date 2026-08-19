-- Milestone 2A.5 -- multi-item withdrawal cart: atomic batch submission.
--
-- The kiosk is moving from "one PIN session = one item" to "one PIN
-- session = a cart of items, submitted together." The cart itself is
-- provisional client/session UI state (app/kiosk/_lib/kioskReducer.ts) --
-- nothing here changes until the employee presses Confirm & Submit, at
-- which point the WHOLE cart must become authoritative ledger rows in one
-- database transaction, or none of it does. Calling the existing
-- single-item record_inventory_withdrawal RPC once per cart line from the
-- browser was explicitly rejected: a mid-cart failure would leave some
-- items withdrawn and others not, with no way to tell the employee
-- "your withdrawal partially happened."
--
-- ============================================================
-- WHAT'S NEW
-- ============================================================
--   - inventory_withdrawal_batches: one row per employee checkout action
--     (the batch HEADER only -- actor, station, the batch's own
--     idempotency key). It deliberately carries no quantity/item data of
--     its own; inventory_movements/inventory_movement_lines remain the
--     sole inventory-quantity authority, exactly as before. Append-only,
--     same forbid_update_delete guard as every other ledger-adjacent
--     table.
--   - inventory_movements.withdrawal_batch_id: nullable link back to the
--     batch a movement belongs to. Null for every pre-existing row and
--     for anything still written through the single-item RPC (2A.5's
--     "single item still works" requirement -- that RPC is UNCHANGED by
--     this migration) -- only batch-created movements ever set it.
--   - normalize_withdrawal_batch_cart_lines(jsonb): pure normalization
--     helper. A batch can contain multiple visual cart lines for the
--     same item+location+unit (the UI is expected to combine those
--     itself, but the server never trusts that it did) -- lines with no
--     measured_base_quantity are fungible and are summed together here;
--     a line carrying an actual measured (weighed/counted) reading is a
--     specific physical fact and is never summed with another. Reused by
--     the batch RPC both to build what actually gets inserted and, on a
--     retry, to compare the freshly-normalized incoming payload against
--     what was already committed -- so idempotency comparison and actual
--     insertion can never drift apart from using two different
--     normalization rules.
--   - record_inventory_withdrawal_batch(...): the one new authoritative
--     write path. One ISSUE_TO_STATION movement per DISTINCT source
--     location touched by the batch (inventory_movements.location_id
--     must remain exactly "the physical location this movement affects,"
--     per 20260811100073 -- a batch spanning locations cannot be one
--     movement), each carrying every one of that location's lines.
--     Deterministic lock order (every UNIQUE (item, location) pair,
--     sorted ascending by the SAME shared inventory_location_lock_key(...)
--     every other availability-sensitive RPC already uses) before any
--     balance is read -- this is what keeps a multi-location batch from
--     ever deadlocking against another concurrent withdrawal/transfer,
--     regardless of what order either caller's own cart happened to list
--     locations in. Availability is re-validated AFTER every line's real,
--     trigger-computed normalized_base_quantity is known (same ordering
--     fix as 20260811100076), using a balance formula that explicitly
--     excludes this batch's own just-inserted rows -- giving the correct
--     "pre-withdrawal" balance without needing to snapshot anything
--     before the inserts. ANY short line rolls back the ENTIRE batch
--     (raising an exception aborts every insert this call made, since
--     the whole function body is one transaction) and reports EVERY
--     short line, not just the first. HIGH_WITHDRAWAL is evaluated per
--     line exactly as the single-item RPC does and never blocks. Batch-
--     level idempotency: one client_request_id for the whole checkout,
--     compared against the reconstructed normalized set of already-
--     committed lines on retry -- reordered-but-identical carts replay
--     cleanly; a changed cart under the same id fails closed.

-- ============================================================
-- 1. Batch header
-- ============================================================
create table public.inventory_withdrawal_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  performed_by_app_user_id uuid not null,
  station_id uuid not null,
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint inventory_withdrawal_batches_actor_org_fk foreign key (performed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_withdrawal_batches_station_org_fk foreign key (station_id, organization_id)
    references public.stations (id, organization_id),
  constraint inventory_withdrawal_batches_id_org_key unique (id, organization_id)
);

create unique index inventory_withdrawal_batches_org_client_request_id_key
  on public.inventory_withdrawal_batches (organization_id, client_request_id);

create trigger inventory_withdrawal_batches_forbid_update
  before update on public.inventory_withdrawal_batches
  for each row execute function public.forbid_update_delete();

create trigger inventory_withdrawal_batches_forbid_delete
  before delete on public.inventory_withdrawal_batches
  for each row execute function public.forbid_update_delete();

alter table public.inventory_withdrawal_batches enable row level security;
-- Deny-by-default: no policies for anon/authenticated. Only the batch RPC
-- (security definer) ever writes this table.
revoke all on public.inventory_withdrawal_batches from public;
grant select on public.inventory_withdrawal_batches to service_role;

-- ============================================================
-- 2. Movement -> batch linkage
-- ============================================================
alter table public.inventory_movements
  add column withdrawal_batch_id uuid;

alter table public.inventory_movements
  add constraint inventory_movements_withdrawal_batch_org_fk
  foreign key (withdrawal_batch_id, organization_id)
  references public.inventory_withdrawal_batches (id, organization_id);

create index inventory_movements_withdrawal_batch_idx
  on public.inventory_movements (withdrawal_batch_id)
  where withdrawal_batch_id is not null;

-- ============================================================
-- 3. Cart normalization -- shared by insertion and idempotency replay
-- ============================================================
create function public.normalize_withdrawal_batch_cart_lines(p_cart_lines jsonb)
returns table (
  out_inventory_item_id uuid,
  out_source_location_id uuid,
  out_entered_unit_id uuid,
  out_entered_quantity numeric,
  out_measured_base_quantity numeric
)
language sql
immutable
set search_path = ''
as $$
  with raw as (
    select
      (elem->>'inventoryItemId')::uuid as inventory_item_id,
      (elem->>'sourceLocationId')::uuid as source_location_id,
      (elem->>'enteredUnitId')::uuid as entered_unit_id,
      (elem->>'enteredQuantity')::numeric as entered_quantity,
      case when elem->>'measuredBaseQuantity' is null then null else (elem->>'measuredBaseQuantity')::numeric end as measured_base_quantity
    from jsonb_array_elements(coalesce(p_cart_lines, '[]'::jsonb)) as elem
  )
  select inventory_item_id, source_location_id, entered_unit_id, sum(entered_quantity), null::numeric
    from raw
   where measured_base_quantity is null
   group by inventory_item_id, source_location_id, entered_unit_id
  union all
  select inventory_item_id, source_location_id, entered_unit_id, entered_quantity, measured_base_quantity
    from raw
   where measured_base_quantity is not null;
$$;

revoke all on function public.normalize_withdrawal_batch_cart_lines(jsonb) from public;
grant execute on function public.normalize_withdrawal_batch_cart_lines(jsonb) to service_role;

-- ============================================================
-- 4. Atomic batch submission
-- ============================================================
create function public.record_inventory_withdrawal_batch(
  p_performed_by_app_user_id uuid,
  p_station_id uuid,
  p_client_request_id uuid,
  p_cart_lines jsonb,
  p_notes text default null
)
returns table (
  out_withdrawal_batch_id uuid,
  out_movement_id uuid,
  out_movement_line_id uuid,
  out_inventory_item_id uuid,
  out_source_location_id uuid,
  out_normalized_base_quantity numeric,
  out_base_unit_id uuid,
  out_exception_id uuid,
  out_exception_raised boolean,
  out_replayed boolean
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
  v_batch_id uuid;
  v_existing_batch_id uuid;
  v_existing_actor uuid;
  v_existing_station uuid;
  v_mismatch boolean;
  v_lock_key bigint;
  v_insufficient jsonb;
  v_line_count integer;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select count(*) into v_line_count from public.normalize_withdrawal_batch_cart_lines(p_cart_lines);
  if coalesce(v_line_count, 0) = 0 then
    raise exception 'p_cart_lines must contain at least one line';
  end if;

  -- 1. Resolve and validate the acting employee. Never trust
  -- organization_id from the caller.
  select au.organization_id, au.employee_id
    into v_org_id, v_employee_id
    from public.app_users au
   where au.id = p_performed_by_app_user_id
     and au.is_active;

  if not found then
    raise exception 'performed_by_app_user_id % is not an active app user', p_performed_by_app_user_id;
  end if;

  -- 2. Batch-level idempotency (ONE client_request_id for the whole
  -- checkout, Part 18). A retry must match the original actor/station
  -- and, once normalized, the original SET of cart lines -- reordered
  -- but otherwise identical is still identical; anything else fails
  -- closed rather than silently replaying (or worse, extending) a
  -- different checkout.
  select b.id, b.performed_by_app_user_id, b.station_id
    into v_existing_batch_id, v_existing_actor, v_existing_station
    from public.inventory_withdrawal_batches b
   where b.organization_id = v_org_id
     and b.client_request_id = p_client_request_id;

  if found then
    if v_existing_actor is distinct from p_performed_by_app_user_id
       or v_existing_station is distinct from p_station_id
    then
      raise exception 'client_request_id % was already used by a different actor or station', p_client_request_id;
    end if;

    select
      exists (
        select out_inventory_item_id, out_source_location_id, out_entered_unit_id, out_entered_quantity, out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines)
        except
        select ml.inventory_item_id, im.location_id, ml.entered_unit_id, ml.entered_quantity, ml.measured_base_quantity
          from public.inventory_movement_lines ml
          join public.inventory_movements im on im.id = ml.movement_id
         where im.withdrawal_batch_id = v_existing_batch_id
      )
      or exists (
        select ml.inventory_item_id, im.location_id, ml.entered_unit_id, ml.entered_quantity, ml.measured_base_quantity
          from public.inventory_movement_lines ml
          join public.inventory_movements im on im.id = ml.movement_id
         where im.withdrawal_batch_id = v_existing_batch_id
        except
        select out_inventory_item_id, out_source_location_id, out_entered_unit_id, out_entered_quantity, out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines)
      )
      into v_mismatch;

    if v_mismatch then
      raise exception 'client_request_id % was already used with a different withdrawal batch payload', p_client_request_id;
    end if;

    return query
      select v_existing_batch_id, im.id, ml.id, ml.inventory_item_id, im.location_id,
             ml.normalized_base_quantity, ml.base_unit_id, ex.id, ex.id is not null, true
        from public.inventory_movement_lines ml
        join public.inventory_movements im on im.id = ml.movement_id
        left join public.exceptions ex on ex.source_movement_line_id = ml.id
       where im.withdrawal_batch_id = v_existing_batch_id
       order by im.location_id, ml.id;
    return;
  end if;

  select e.status, e.default_station_id, e.auto_resolve_station, e.can_change_station
    into v_employee_status, v_default_station_id, v_auto_resolve_station, v_can_change_station
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization -- identical rule to the single-item RPC.
  -- Every movement in a batch shares one station (Part 8: everything in
  -- one submission belongs to the same current session station).
  if v_auto_resolve_station and not v_can_change_station then
    if p_station_id is distinct from v_default_station_id then
      raise exception 'employee % is restricted to their default station and may not use station %',
        v_employee_id, p_station_id;
    end if;
  end if;

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

  v_business_date := (now() at time zone v_timezone)::date;

  -- 4. Per-line structural validation (Part 14 -- never trust the
  -- browser to have deduplicated OR validated correctly), before
  -- acquiring any locks: every source location must be active and
  -- storage-eligible, every item must be an active item in this org.
  if exists (
    select 1
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     where not exists (
       select 1 from public.locations l
        where l.id = c.out_source_location_id and l.organization_id = v_org_id and l.is_active and l.is_storage_eligible
     )
  ) then
    raise exception 'one or more source locations in the batch are not active, storage-eligible locations in organization %', v_org_id
      using errcode = 'GA021';
  end if;

  if exists (
    select 1
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     where not exists (
       select 1 from public.inventory_items i
        where i.id = c.out_inventory_item_id and i.organization_id = v_org_id and i.status = 'active'
     )
  ) then
    raise exception 'one or more items in the batch are not active items in organization %', v_org_id;
  end if;

  -- 5. Deterministic, globally-consistent lock acquisition (Part 15):
  -- every UNIQUE (item, source location) pair in the batch, sorted
  -- ascending by the SAME shared inventory_location_lock_key(...) every
  -- other availability-sensitive RPC uses -- never browser/payload
  -- order. A batch touching Item A/Loc X, Item B/Loc Y, Item C/Loc X
  -- cannot deadlock against a concurrent withdrawal/transfer that
  -- happens to touch the same locations in a different order, because
  -- every caller that ever needs more than one of these locks acquires
  -- them in this one global total order.
  for v_lock_key in
    select distinct public.inventory_location_lock_key(v_org_id, c.out_inventory_item_id, c.out_source_location_id)
      from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  -- 6. Batch header -- ONE row per employee checkout action. Carries no
  -- quantity/item data; the ledger below remains the sole authority.
  insert into public.inventory_withdrawal_batches (
    organization_id, performed_by_app_user_id, station_id, client_request_id
  ) values (
    v_org_id, p_performed_by_app_user_id, p_station_id, p_client_request_id
  ) returning id into v_batch_id;

  -- 7. One ISSUE_TO_STATION movement per DISTINCT source location
  -- touched by the batch (Part 13 -- location_id must remain exactly
  -- the physical location one movement affects; a batch spanning
  -- locations cannot be one movement).
  insert into public.inventory_movements (
    organization_id, location_id, station_id, movement_type,
    performed_by_app_user_id, business_date, notes, location_attribution, withdrawal_batch_id
  )
  select v_org_id, c.out_source_location_id, p_station_id, 'ISSUE_TO_STATION',
         p_performed_by_app_user_id, v_business_date, p_notes, 'EXACT', v_batch_id
    from (select distinct out_source_location_id from public.normalize_withdrawal_batch_cart_lines(p_cart_lines)) c;

  -- 8. One movement line per normalized cart line, attached to its
  -- location's movement header. enforce_movement_line_measurement()
  -- (unchanged, existing trigger) validates the item/unit pair FIRST and
  -- computes the authoritative normalized_base_quantity -- never
  -- reimplemented here, exactly like the single-item RPC.
  insert into public.inventory_movement_lines (
    movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
  )
  select im.id, c.out_inventory_item_id, c.out_entered_quantity, c.out_entered_unit_id, c.out_measured_base_quantity
    from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
    join public.inventory_movements im
      on im.withdrawal_batch_id = v_batch_id and im.location_id = c.out_source_location_id;

  -- 9. Authoritative availability re-check (Part 16), AFTER every
  -- line's real, trigger-computed normalized_base_quantity is known
  -- (same ordering fix as 20260811100076). The balance formula here is
  -- the SAME three-term formula as inventory_location_item_balance,
  -- with one addition: it explicitly excludes THIS batch's own just-
  -- inserted outbound rows (m2.withdrawal_batch_id is distinct from
  -- v_batch_id), which is what gives the correct pre-withdrawal balance
  -- without needing to snapshot anything before step 8's inserts.
  -- Pre-existing rows (legacy, or written by the single-item RPC, which
  -- never sets withdrawal_batch_id) are correctly still counted as prior
  -- outbound activity. ALL short lines are collected, not just the
  -- first, and the raise below rolls back the ENTIRE transaction --
  -- every insert this call made, across every location -- so nothing
  -- ever partially commits.
  select jsonb_agg(jsonb_build_object(
           'inventoryItemId', x.inventory_item_id,
           'sourceLocationId', x.location_id,
           'availableQuantity', x.available_quantity,
           'requestedQuantity', x.requested_quantity
         ))
    into v_insufficient
    from (
      select ml.inventory_item_id, im.location_id,
             sum(ml.normalized_base_quantity) as requested_quantity,
             coalesce((
               select sum(ml2.normalized_base_quantity)
                 from public.inventory_movement_lines ml2
                 join public.inventory_movements m2 on m2.id = ml2.movement_id
                where m2.organization_id = v_org_id
                  and m2.location_id = im.location_id
                  and ml2.inventory_item_id = ml.inventory_item_id
                  and m2.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN')
             ), 0)
             - coalesce((
               select sum(ml2.normalized_base_quantity)
                 from public.inventory_movement_lines ml2
                 join public.inventory_movements m2 on m2.id = ml2.movement_id
                where m2.organization_id = v_org_id
                  and m2.location_id = im.location_id
                  and ml2.inventory_item_id = ml.inventory_item_id
                  and m2.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT')
                  and m2.location_attribution = 'EXACT'
                  and m2.withdrawal_batch_id is distinct from v_batch_id
             ), 0)
             - coalesce((
               select a.allocated_outbound_quantity
                 from public.inventory_legacy_location_allocations a
                where a.organization_id = v_org_id
                  and a.inventory_item_id = ml.inventory_item_id
                  and a.location_id = im.location_id
             ), 0) as available_quantity
        from public.inventory_movement_lines ml
        join public.inventory_movements im on im.id = ml.movement_id
       where im.withdrawal_batch_id = v_batch_id
       group by ml.inventory_item_id, im.location_id
    ) x
   where x.requested_quantity > x.available_quantity;

  if v_insufficient is not null then
    raise exception 'insufficient inventory for one or more items in this batch'
      using errcode = 'GA022', detail = v_insufficient::text;
  end if;

  -- 10. HIGH_WITHDRAWAL, per line -- station-specific rule preferred
  -- over the item's org-wide default rule, exactly as the single-item
  -- RPC resolves it. Never blocks: every insert above is already staged
  -- for commit regardless of this step.
  insert into public.exceptions (
    organization_id, exception_type, control_rule_id,
    source_movement_id, source_movement_line_id, inventory_item_id, station_id,
    observed_quantity, threshold_quantity_at_detection, base_unit_id
  )
  select v_org_id, 'HIGH_WITHDRAWAL', r.rule_id,
         im.id, ml.id, ml.inventory_item_id, p_station_id,
         ml.normalized_base_quantity, r.threshold_quantity, ml.base_unit_id
    from public.inventory_movement_lines ml
    join public.inventory_movements im on im.id = ml.movement_id
    join lateral (
      select cr.id as rule_id, cr.threshold_quantity
        from public.control_rules cr
       where cr.organization_id = v_org_id
         and cr.inventory_item_id = ml.inventory_item_id
         and cr.rule_type = 'HIGH_WITHDRAWAL'
         and cr.is_active
         and (cr.station_id = p_station_id or cr.station_id is null)
       order by (cr.station_id is null)
       limit 1
    ) r on true
   where im.withdrawal_batch_id = v_batch_id
     and ml.normalized_base_quantity > r.threshold_quantity;

  -- 11. One audit event for the whole batch checkout (Part 27) -- a
  -- compact index into the ledger (who / station / batch / movements /
  -- items / locations / when), not a duplicate of it.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  )
  select v_org_id, p_performed_by_app_user_id, 'INVENTORY_WITHDRAWAL_BATCH_RECORDED',
         'inventory_withdrawal_batch', v_batch_id,
         jsonb_build_object(
           'stationId', p_station_id,
           'clientRequestId', p_client_request_id,
           'lines', jsonb_agg(jsonb_build_object(
             'movementId', im.id, 'movementLineId', ml.id, 'inventoryItemId', ml.inventory_item_id,
             'sourceLocationId', im.location_id, 'normalizedBaseQuantity', ml.normalized_base_quantity,
             'baseUnitId', ml.base_unit_id
           ))
         )
    from public.inventory_movement_lines ml
    join public.inventory_movements im on im.id = ml.movement_id
   where im.withdrawal_batch_id = v_batch_id;

  return query
    select v_batch_id, im.id, ml.id, ml.inventory_item_id, im.location_id,
           ml.normalized_base_quantity, ml.base_unit_id, ex.id, ex.id is not null, false
      from public.inventory_movement_lines ml
      join public.inventory_movements im on im.id = ml.movement_id
      left join public.exceptions ex on ex.source_movement_line_id = ml.id
     where im.withdrawal_batch_id = v_batch_id
     order by im.location_id, ml.id;
end;
$$;

revoke all on function public.record_inventory_withdrawal_batch(uuid, uuid, uuid, jsonb, text) from public;
grant execute on function public.record_inventory_withdrawal_batch(uuid, uuid, uuid, jsonb, text) to service_role;
