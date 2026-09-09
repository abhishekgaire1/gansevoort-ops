-- Safe editing of confirmed items with inventory-impact protection (Part 1
-- of the migration sequence for this feature).
--
-- Adds two new inventory_movements.movement_type values --
-- INVENTORY_CORRECTION_IN / INVENTORY_CORRECTION_OUT -- for the new
-- "Adjust Inventory" and "correct inventory from previous receipts"
-- actions this feature introduces (20260811100141/100142). Deliberately
-- NOT reusing COUNT_ADJUSTMENT_IN/OUT: those specifically mean "physical
-- count reconciliation" and are tied to cycle_count_id
-- (20260811100081/100082) -- conflating them with an ad-hoc manager
-- correction or a receipt-package-factor correction would violate this
-- schema's own rule that movement_type must be explicit, never inferred
-- (docs/DATABASE.md: "Never infer business meaning from positive/negative
-- quantity signs" -- the corollary is that two genuinely different
-- business events must never share one type either).
--
-- Every function that already enumerates the inbound/outbound movement-
-- type lists for balance calculation must be updated in the SAME
-- migration, or the new types would be invisible to some balance reads
-- and visible to others -- a correction that "shows up" in one place but
-- not another is exactly the kind of silent inconsistency this whole
-- feature exists to prevent. Four currently-live functions enumerate
-- these lists (grepped across every migration to confirm only the LATEST
-- body of each matters):
--   1. inventory_location_item_balance (20260811100073) -- scalar,
--      locked-read-before-mutate balance, used by every writer RPC.
--   2. inventory_location_balances (20260811100073) -- set-returning,
--      used by list_inventory_balances (20260811100081) and everywhere
--      else the whole-organization balance table is read.
--   3. list_inventory_balances_for_item (20260811100075) -- kiosk
--      per-item stock-visibility read model.
--   4. record_inventory_withdrawal_batch (latest body: 20260811100130)
--      -- inlines its own copy of the exact-outbound formula (excluding
--      the batch's own just-inserted rows) for its pre-withdrawal
--      sufficiency check; record_inventory_withdrawal (single-item) calls
--      function #1 directly and needs no change.
-- All four are body-only replaces below -- no other schema/business-rule
-- change, no signature change.

alter table public.inventory_movements
  drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
    check (movement_type in (
      'PURCHASE_RECEIPT', 'ISSUE_TO_STATION',
      'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE',
      'COUNT_ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_OUT',
      'INVENTORY_CORRECTION_IN', 'INVENTORY_CORRECTION_OUT'
    ));

-- ============================================================
-- 1. inventory_location_item_balance -- body-only replace
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
         and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN', 'INVENTORY_CORRECTION_IN')
    ), 0)
    - coalesce((
      select sum(ml.normalized_base_quantity)
        from public.inventory_movement_lines ml
        join public.inventory_movements m on m.id = ml.movement_id
       where m.organization_id = p_organization_id
         and m.location_id = p_location_id
         and ml.inventory_item_id = p_inventory_item_id
         and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT')
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

-- ============================================================
-- 2. inventory_location_balances -- body-only replace (signature
--    unchanged since 20260811100073, so a plain CREATE OR REPLACE works)
-- ============================================================
create or replace function public.inventory_location_balances(p_organization_id uuid)
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
       and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN', 'INVENTORY_CORRECTION_IN')
     group by ml.inventory_item_id, m.location_id
  ),
  exact_outbound as (
    select ml.inventory_item_id, m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT')
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

-- ============================================================
-- 3. list_inventory_balances_for_item -- body-only replace
-- ============================================================
create or replace function public.list_inventory_balances_for_item(
  p_organization_id uuid, p_inventory_item_id uuid
)
returns table (
  out_location_id uuid,
  out_location_name text,
  out_base_unit_code text,
  out_balance numeric,
  out_full_reference_quantity numeric,
  out_reference_source text,
  out_includes_legacy_estimate boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with inbound as (
    select m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and ml.inventory_item_id = p_inventory_item_id
       and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN', 'INVENTORY_CORRECTION_IN')
     group by m.location_id
  ),
  exact_outbound as (
    select m.location_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and ml.inventory_item_id = p_inventory_item_id
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT')
       and m.location_attribution = 'EXACT'
     group by m.location_id
  ),
  legacy as (
    select location_id, allocated_outbound_quantity as qty
      from public.inventory_legacy_location_allocations
     where organization_id = p_organization_id
       and inventory_item_id = p_inventory_item_id
  ),
  locations_touched as (
    select location_id from inbound
    union
    select location_id from exact_outbound
    union
    select location_id from legacy
  )
  select
    lt.location_id,
    loc.name,
    u.code,
    coalesce(i.qty, 0) - coalesce(eo.qty, 0) - coalesce(lg.qty, 0),
    ref.full_quantity,
    ref.source,
    coalesce(lg.qty, 0) > 0
  from locations_touched lt
  join public.locations loc on loc.id = lt.location_id
  join public.inventory_items ii on ii.id = p_inventory_item_id
  join public.units u on u.id = ii.base_unit_id
  left join inbound i on i.location_id = lt.location_id
  left join exact_outbound eo on eo.location_id = lt.location_id
  left join legacy lg on lg.location_id = lt.location_id
  left join lateral (
    select r.full_quantity, r.source
      from public.inventory_stock_references r
     where r.organization_id = p_organization_id
       and r.inventory_item_id = p_inventory_item_id
       and r.location_id = lt.location_id
     order by r.created_at desc, r.id desc
     limit 1
  ) ref on true
  where coalesce(i.qty, 0) - coalesce(eo.qty, 0) - coalesce(lg.qty, 0) > 0
  order by loc.name;
$$;

-- ============================================================
-- 4. record_inventory_withdrawal_batch -- body-only replace, appended
--    below (its own comment block explains the one inline change).
-- ============================================================
create or replace function public.record_inventory_withdrawal_batch(
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
        select c.out_inventory_item_id, c.out_source_location_id, c.out_entered_unit_id, c.out_entered_quantity, c.out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
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
        select c.out_inventory_item_id, c.out_source_location_id, c.out_entered_unit_id, c.out_entered_quantity, c.out_measured_base_quantity
          from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c
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

  select e.status
    into v_employee_status
    from public.employees e
   where e.id = v_employee_id;

  if v_employee_status is distinct from 'active' then
    raise exception 'employee % is not active', v_employee_id;
  end if;

  -- 3. Station authorization (kiosk station assignment enforcement) --
  -- identical rule to the single-item RPC. Every movement in a batch
  -- shares one station (Part 8: everything in one submission belongs to
  -- the same current session station); the submitted station must be one
  -- this employee is ACTIVELY ASSIGNED to, in the SAME organization, with
  -- no bypass for any employee/role.
  if not exists (
    select 1
      from public.employee_station_assignments esa
      join public.stations s on s.id = esa.station_id
     where esa.employee_id = v_employee_id
       and esa.station_id = p_station_id
       and esa.organization_id = v_org_id
       and esa.is_active
       and s.organization_id = v_org_id
       and s.is_active
  ) then
    raise exception 'employee % is not assigned to active station %', v_employee_id, p_station_id
      using errcode = 'GA073';
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
  select v_org_id, locs.out_source_location_id, p_station_id, 'ISSUE_TO_STATION',
         p_performed_by_app_user_id, v_business_date, p_notes, 'EXACT', v_batch_id
    from (select distinct c.out_source_location_id from public.normalize_withdrawal_batch_cart_lines(p_cart_lines) c) locs;

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
                  and m2.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN', 'INVENTORY_CORRECTION_IN')
             ), 0)
             - coalesce((
               select sum(ml2.normalized_base_quantity)
                 from public.inventory_movement_lines ml2
                 join public.inventory_movements m2 on m2.id = ml2.movement_id
                where m2.organization_id = v_org_id
                  and m2.location_id = im.location_id
                  and ml2.inventory_item_id = ml.inventory_item_id
                  and m2.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT')
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

  -- 10b. RC1 High-Withdrawal Manager Visibility -- one notification per
  -- eligible recipient per NEW exception created in step 10 above (a
  -- batch touching several over-threshold lines can create several
  -- exceptions; each gets its own broadcast, never collapsed into one
  -- per batch). Every exception this query finds was necessarily just
  -- created above -- v_batch_id is brand new (step 6), so no exception
  -- from an earlier call could possibly reference a movement under it.
  -- The whole replay branch above already returns before this point, so
  -- a retried/duplicate submission never sends a second notification
  -- either. Purely informational: nothing here can affect the batch,
  -- which is already fully recorded.
  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  )
  select v_org_id, recipient.app_user_id, 'HIGH_WITHDRAWAL', 'exception', ex.id,
    'High withdrawal recorded',
    format('%s %s of %s withdrawn at %s (threshold %s %s).', ex.observed_quantity, u.code, i.name, s.name, ex.threshold_quantity_at_detection, u.code),
    jsonb_build_object(
      'exceptionId', ex.id,
      'inventoryItemId', ex.inventory_item_id,
      'stationId', ex.station_id,
      'observedQuantity', ex.observed_quantity,
      'thresholdQuantity', ex.threshold_quantity_at_detection,
      'performedByAppUserId', p_performed_by_app_user_id
    )
    from public.exceptions ex
    join public.inventory_movements im on im.id = ex.source_movement_id
    join public.inventory_items i on i.id = ex.inventory_item_id
    join public.stations s on s.id = ex.station_id
    join public.units u on u.id = ex.base_unit_id
    cross join (
      select distinct au.id as app_user_id
        from public.app_users au
        join public.user_roles ur on ur.app_user_id = au.id
        join public.roles r on r.id = ur.role_id
       where au.organization_id = v_org_id
         and au.is_active
         and r.name in ('manager', 'admin')
         and au.id <> p_performed_by_app_user_id
    ) recipient
   where im.withdrawal_batch_id = v_batch_id;

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
