-- Inventory Waste (Milestone: Inventory Waste, Phase A-C).
--
-- Scope is deliberately narrow: known inventory loss from an EXACT
-- physical storage location, BEFORE that inventory has been withdrawn to
-- a station. Station/prep/end-of-day waste is explicitly out of scope --
-- a separate future workflow with different bulk-entry and accounting
-- semantics. Transfers are also out of scope.
--
-- Purely additive. WASTE is already a valid movement_type (20260811100073
-- widened inventory_movements_movement_type_check) and is already
-- subtracted by inventory_location_item_balance() when
-- location_attribution = 'EXACT' -- no movement-type/balance-formula
-- change is needed here at all. This migration only adds: the durable
-- Inventory Waste business record (inventory_waste_events), and the RPCs
-- that write/read it.
--
-- ============================================================
-- 1. inventory_waste_events -- the durable business record.
-- ============================================================
-- The ledger (inventory_movements/inventory_movement_lines) remains
-- authoritative for BALANCE; this table preserves the business
-- EXPLANATION (reason, note, who) and links 1:1 to the WASTE movement it
-- caused, via a unique FK -- never duplicating ledger truth (quantity/
-- location/item are still read from the movement line when needed, but
-- are ALSO stored here directly since they're intrinsic to "what was
-- wasted," not derived facts, and every other business-record table in
-- this schema -- e.g. inventory_cycle_counts -- does the same).
create table public.inventory_waste_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  location_id uuid not null,
  inventory_item_id uuid not null,
  quantity numeric not null,
  unit_code text not null,
  reason_code text not null,
  note text,
  recorded_by_app_user_id uuid not null,
  recorded_at timestamptz not null default now(),
  client_request_id uuid not null,
  inventory_movement_id uuid not null,
  -- Set only when this waste was identified during, and recorded from,
  -- a Cycle Count (Phase E-G) -- null for a standalone waste entry.
  cycle_count_id uuid,
  cycle_count_line_id uuid,
  created_at timestamptz not null default now(),
  constraint inventory_waste_events_quantity_check check (quantity > 0),
  constraint inventory_waste_events_reason_check
    check (reason_code in ('EXPIRED', 'SPOILED', 'DAMAGED', 'CONTAMINATED', 'STORAGE_ISSUE', 'OTHER')),
  -- OTHER requires a non-blank note; every other reason may omit one.
  -- Trimming/blank-rejection is also enforced in the RPC (never trust a
  -- CHECK's error message alone for a friendly UI error), but this stays
  -- as defense in depth against any future direct-write mistake.
  constraint inventory_waste_events_other_requires_note_check
    check (reason_code <> 'OTHER' or (note is not null and btrim(note) <> '')),
  constraint inventory_waste_events_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint inventory_waste_events_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_waste_events_recorded_by_org_fk foreign key (recorded_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_waste_events_cycle_count_org_fk foreign key (cycle_count_id, organization_id)
    references public.inventory_cycle_counts (id, organization_id),
  constraint inventory_waste_events_cycle_count_line_org_fk foreign key (cycle_count_line_id, organization_id)
    references public.inventory_cycle_count_lines (id, organization_id),
  -- Every waste event MUST have caused exactly one WASTE movement --
  -- strong 1:1 link, never a bare unconstrained uuid column (Part 12's
  -- "strong FK/link between waste event and its WASTE movement").
  -- Composite (id, organization_id), matching every other cross-entity FK
  -- in this schema -- never a plain single-column FK, even though the RPC
  -- itself always derives organization_id server-side and could never
  -- mismatch it in practice.
  constraint inventory_waste_events_movement_org_fk foreign key (inventory_movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint inventory_waste_events_movement_key unique (inventory_movement_id),
  -- Idempotency: same shape as inventory_movements_org_client_request_id_key.
  constraint inventory_waste_events_org_client_request_id_key unique (organization_id, client_request_id),
  -- Composite-FK target for inventory_cycle_count_lines.waste_event_id
  -- (Phase E, 20260811100086) -- same pattern as inventory_movements_id_
  -- org_key/inventory_cycle_counts_id_org_key elsewhere in this schema.
  constraint inventory_waste_events_id_org_key unique (id, organization_id)
);

create index inventory_waste_events_org_location_idx on public.inventory_waste_events (organization_id, location_id);
create index inventory_waste_events_org_recorded_at_idx on public.inventory_waste_events (organization_id, recorded_at desc);
create index inventory_waste_events_cycle_count_line_idx on public.inventory_waste_events (cycle_count_line_id) where cycle_count_line_id is not null;

-- Append-only, like every other posted ledger-adjacent business fact in
-- this schema (Part 38 -- "do not permit direct UPDATE/DELETE... If a
-- mistake must later be corrected, design an explicit reversal workflow
-- [later]"). Reuses the SAME shared, table-name-agnostic guard
-- inventory_movements/inventory_movement_lines/audit_events already use
-- (20260811100005) rather than a bespoke per-table trigger.
create trigger inventory_waste_events_forbid_update
  before update on public.inventory_waste_events
  for each row execute function public.forbid_update_delete();

create trigger inventory_waste_events_forbid_delete
  before delete on public.inventory_waste_events
  for each row execute function public.forbid_update_delete();

alter table public.inventory_waste_events enable row level security;
-- Deny-by-default, same posture as every other table in this schema --
-- no anon/authenticated policies; all access goes through SECURITY
-- DEFINER RPCs below, callable only by service_role.

-- ============================================================
-- 2. record_inventory_waste -- the standalone waste-recording operation.
-- ============================================================
-- Mirrors record_inventory_withdrawal's structure and idempotency
-- contract closely (Part 11/42's "follow existing inventory withdrawal
-- idempotency conventions"), simplified where Waste's rules are simpler:
-- no station/packaging-unit concept at all -- the item's OWN base unit is
-- resolved server-side and used unconditionally, never accepted as a
-- client parameter (Part 8: "Do not introduce CASE/BOX conversion here").
create function public.record_inventory_waste(
  p_recorded_by_app_user_id uuid,
  p_location_id uuid,
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_reason_code text,
  p_note text,
  p_client_request_id uuid,
  -- Set only by record_cycle_count_line_waste (Phase F,
  -- 20260811100087), which calls this function directly to reuse its
  -- locking/idempotency/insert logic rather than duplicating it -- null
  -- for every standalone waste entry (Part 12's cycle_count_id/
  -- cycle_count_line_id nullable traceability columns).
  p_cycle_count_id uuid default null,
  p_cycle_count_line_id uuid default null
) returns table (
  out_waste_event_id uuid,
  out_movement_id uuid,
  out_movement_line_id uuid,
  out_quantity numeric,
  out_unit_code text,
  out_replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_base_unit_id uuid;
  v_unit_code text;
  v_unit_type text;
  v_location_timezone text;
  v_business_date date;
  v_note text;
  v_current_balance numeric;
  v_movement_id uuid;
  v_line_id uuid;
  v_waste_event_id uuid;
  v_existing record;
begin
  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;

  select organization_id into v_org_id
    from public.app_users au
   where au.id = p_recorded_by_app_user_id and au.is_active;

  if not found then
    raise exception 'recorded_by_app_user_id % is not an active app user', p_recorded_by_app_user_id;
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- Idempotency check FIRST (before any validation that could differ
  -- between the original attempt and a retry due to intervening state
  -- change) -- a retry must match the ORIGINAL request on every
  -- business-significant field or fail closed, exactly like
  -- record_inventory_withdrawal.
  select we.id as existing_waste_event_id, we.inventory_movement_id as existing_movement_id,
         we.location_id as existing_location_id, we.inventory_item_id as existing_inventory_item_id,
         we.quantity as existing_quantity, we.reason_code as existing_reason_code,
         we.note as existing_note, we.recorded_by_app_user_id as existing_recorded_by_app_user_id,
         we.unit_code as existing_unit_code, we.cycle_count_id as existing_cycle_count_id,
         we.cycle_count_line_id as existing_cycle_count_line_id,
         ml.id as existing_movement_line_id
    into v_existing
    from public.inventory_waste_events we
    join public.inventory_movement_lines ml on ml.movement_id = we.inventory_movement_id
   where we.organization_id = v_org_id
     and we.client_request_id = p_client_request_id;

  if found then
    if v_existing.existing_recorded_by_app_user_id is distinct from p_recorded_by_app_user_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_quantity is distinct from p_quantity
       or v_existing.existing_reason_code is distinct from p_reason_code
       or v_existing.existing_note is distinct from v_note
       or v_existing.existing_cycle_count_id is distinct from p_cycle_count_id
       or v_existing.existing_cycle_count_line_id is distinct from p_cycle_count_line_id
    then
      raise exception 'client_request_id % was already used with a different waste payload', p_client_request_id
        using errcode = 'GA029';
    end if;

    return query select
      v_existing.existing_waste_event_id, v_existing.existing_movement_id, v_existing.existing_movement_line_id,
      v_existing.existing_quantity, v_existing.existing_unit_code, true;
    return;
  end if;

  -- Reason + note validation (Part 14) -- server-enforced, never
  -- frontend-only. Blank-after-trim is never accepted for OTHER. An
  -- unrecognized reason_code is a defensive/theoretical guard only (the
  -- UI only ever sends one of the six controlled values) so it is not
  -- part of the GA0xx taxonomy the UI parses -- WASTE_NOTE_REQUIRED
  -- (GA028) is reserved specifically for the OTHER-requires-note case.
  if p_reason_code not in ('EXPIRED', 'SPOILED', 'DAMAGED', 'CONTAMINATED', 'STORAGE_ISSUE', 'OTHER') then
    raise exception 'reason_code % is not a recognized waste reason', p_reason_code;
  end if;
  if p_reason_code = 'OTHER' and v_note is null then
    raise exception 'a note is required when waste reason is OTHER'
      using errcode = 'GA028';
  end if;

  -- Quantity validation (Part 8/10) -- must be positive; COUNT-category
  -- base units must be a whole number (checked below once the base unit
  -- is resolved).
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'waste quantity must be greater than zero'
      using errcode = 'GA026';
  end if;

  -- Location: active AND storage-eligible only (Part 6) -- a
  -- business/site/station location is never a valid waste location, same
  -- rule record_inventory_withdrawal already enforces for its source
  -- location.
  select timezone into v_location_timezone
    from public.locations
   where id = p_location_id and organization_id = v_org_id and is_active and is_storage_eligible;

  if not found then
    raise exception 'location_id % is not an active, storage-eligible location in organization %', p_location_id, v_org_id
      using errcode = 'GA021';
  end if;

  -- Item: active only, same organization.
  select i.base_unit_id, u.code, u.unit_type
    into v_base_unit_id, v_unit_code, v_unit_type
    from public.inventory_items i
    join public.units u on u.id = i.base_unit_id
   where i.id = p_inventory_item_id and i.organization_id = v_org_id and i.status = 'active';

  if not found then
    raise exception 'inventory_item_id % is not an active item in organization %', p_inventory_item_id, v_org_id
      using errcode = 'GA027';
  end if;

  if v_unit_type = 'COUNT' and p_quantity <> trunc(p_quantity) then
    raise exception 'waste quantity % must be a whole number for a COUNT-unit item', p_quantity
      using errcode = 'GA026';
  end if;

  v_business_date := (now() at time zone v_location_timezone)::date;

  -- Serialize on (organization, item, location) BEFORE reading the
  -- authoritative pre-waste balance -- identical locking discipline to
  -- record_inventory_withdrawal (Part 10).
  perform pg_advisory_xact_lock(public.inventory_location_lock_key(v_org_id, p_inventory_item_id, p_location_id));
  v_current_balance := public.inventory_location_item_balance(v_org_id, p_inventory_item_id, p_location_id);

  if p_quantity > v_current_balance then
    raise exception 'waste quantity % exceeds available inventory % at location %', p_quantity, v_current_balance, p_location_id
      using errcode = 'GA022',
            detail = jsonb_build_object('availableQuantity', v_current_balance, 'requestedQuantity', p_quantity)::text;
  end if;

  begin
    insert into public.inventory_movements as im (
      organization_id, location_id, station_id, movement_type,
      performed_by_app_user_id, business_date, notes, client_request_id, location_attribution, cycle_count_id
    ) values (
      v_org_id, p_location_id, null, 'WASTE',
      p_recorded_by_app_user_id, v_business_date, v_note, p_client_request_id, 'EXACT', p_cycle_count_id
    ) returning im.id into v_movement_id;
  exception when unique_violation then
    -- Two genuinely concurrent identical retries -- same race-resolution
    -- shape as record_inventory_withdrawal: the loser re-reads whatever
    -- the winner committed and returns that instead of erroring.
    select we.id as existing_waste_event_id, we.inventory_movement_id as existing_movement_id,
           we.location_id as existing_location_id, we.inventory_item_id as existing_inventory_item_id,
           we.quantity as existing_quantity, we.reason_code as existing_reason_code,
           we.note as existing_note, we.recorded_by_app_user_id as existing_recorded_by_app_user_id,
           we.unit_code as existing_unit_code, we.cycle_count_id as existing_cycle_count_id,
           we.cycle_count_line_id as existing_cycle_count_line_id,
           ml.id as existing_movement_line_id
      into v_existing
      from public.inventory_waste_events we
      join public.inventory_movement_lines ml on ml.movement_id = we.inventory_movement_id
     where we.organization_id = v_org_id
       and we.client_request_id = p_client_request_id;

    if not found then
      raise exception 'client_request_id % conflicted but no matching waste event was found on retry', p_client_request_id;
    end if;

    if v_existing.existing_recorded_by_app_user_id is distinct from p_recorded_by_app_user_id
       or v_existing.existing_location_id is distinct from p_location_id
       or v_existing.existing_inventory_item_id is distinct from p_inventory_item_id
       or v_existing.existing_quantity is distinct from p_quantity
       or v_existing.existing_reason_code is distinct from p_reason_code
       or v_existing.existing_note is distinct from v_note
       or v_existing.existing_cycle_count_id is distinct from p_cycle_count_id
       or v_existing.existing_cycle_count_line_id is distinct from p_cycle_count_line_id
    then
      raise exception 'client_request_id % was already used with a different waste payload', p_client_request_id
        using errcode = 'GA029';
    end if;

    return query select
      v_existing.existing_waste_event_id, v_existing.existing_movement_id, v_existing.existing_movement_line_id,
      v_existing.existing_quantity, v_existing.existing_unit_code, true;
    return;
  end;

  insert into public.inventory_movement_lines (movement_id, inventory_item_id, entered_quantity, entered_unit_id, cycle_count_line_id)
  values (v_movement_id, p_inventory_item_id, p_quantity, v_base_unit_id, p_cycle_count_line_id)
  returning id into v_line_id;

  insert into public.inventory_waste_events (
    organization_id, location_id, inventory_item_id, quantity, unit_code, reason_code, note,
    recorded_by_app_user_id, client_request_id, inventory_movement_id, cycle_count_id, cycle_count_line_id
  ) values (
    v_org_id, p_location_id, p_inventory_item_id, p_quantity, v_unit_code, p_reason_code, v_note,
    p_recorded_by_app_user_id, p_client_request_id, v_movement_id, p_cycle_count_id, p_cycle_count_line_id
  ) returning id into v_waste_event_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    v_org_id, p_recorded_by_app_user_id, 'INVENTORY_WASTE_RECORDED', 'inventory_waste_event', v_waste_event_id,
    jsonb_build_object(
      'wasteEventId', v_waste_event_id,
      'itemId', p_inventory_item_id,
      'locationId', p_location_id,
      'quantity', p_quantity,
      'unit', v_unit_code,
      'reason', p_reason_code,
      'cycleCountId', p_cycle_count_id
    )
  );

  return query select v_waste_event_id, v_movement_id, v_line_id, p_quantity, v_unit_code, false;
end;
$$;

revoke all on function public.record_inventory_waste(uuid, uuid, uuid, numeric, text, text, uuid, uuid, uuid) from public;
grant execute on function public.record_inventory_waste(uuid, uuid, uuid, numeric, text, text, uuid, uuid, uuid) to service_role;

-- ============================================================
-- 3. list_inventory_waste_events -- history (Part 18/20).
-- ============================================================
-- Returns the raw recorded_by_app_user_id only -- display-name
-- resolution happens in TS via the SAME batched app_users -> employees
-- embed cycleCounts.ts's resolveEmployeeDisplayNames already uses, not
-- an inline SQL join here (matching this schema's established
-- convention: RPCs return ids, the TS layer batch-resolves names for
-- display, ownership/authorization always compares by id).
create function public.list_inventory_waste_events(
  p_organization_id uuid,
  p_location_id uuid default null,
  p_reason_code text default null,
  p_from_date timestamptz default null,
  p_to_date timestamptz default null,
  p_limit integer default 50
) returns table (
  out_waste_event_id uuid,
  out_location_id uuid,
  out_location_name text,
  out_inventory_item_id uuid,
  out_item_name text,
  out_quantity numeric,
  out_unit_code text,
  out_reason_code text,
  out_note text,
  out_recorded_by_app_user_id uuid,
  out_recorded_at timestamptz,
  out_inventory_movement_id uuid,
  out_cycle_count_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    we.id, we.location_id, loc.name, we.inventory_item_id, item.name,
    we.quantity, we.unit_code, we.reason_code, we.note,
    we.recorded_by_app_user_id,
    we.recorded_at, we.inventory_movement_id, we.cycle_count_id
  from public.inventory_waste_events we
  join public.locations loc on loc.id = we.location_id
  join public.inventory_items item on item.id = we.inventory_item_id
  where we.organization_id = p_organization_id
    and (p_location_id is null or we.location_id = p_location_id)
    and (p_reason_code is null or we.reason_code = p_reason_code)
    and (p_from_date is null or we.recorded_at >= p_from_date)
    and (p_to_date is null or we.recorded_at <= p_to_date)
  order by we.recorded_at desc
  limit p_limit;
$$;

revoke all on function public.list_inventory_waste_events(uuid, uuid, text, timestamptz, timestamptz, integer) from public;
grant execute on function public.list_inventory_waste_events(uuid, uuid, text, timestamptz, timestamptz, integer) to service_role;

-- ============================================================
-- 4. get_inventory_waste_detail -- read-only detail (Part 19).
-- ============================================================
create function public.get_inventory_waste_detail(
  p_organization_id uuid,
  p_waste_event_id uuid
) returns table (
  out_waste_event_id uuid,
  out_location_id uuid,
  out_location_name text,
  out_inventory_item_id uuid,
  out_item_name text,
  out_quantity numeric,
  out_unit_code text,
  out_reason_code text,
  out_note text,
  out_recorded_by_app_user_id uuid,
  out_recorded_at timestamptz,
  out_inventory_movement_id uuid,
  out_cycle_count_id uuid,
  out_cycle_count_line_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    we.id, we.location_id, loc.name, we.inventory_item_id, item.name,
    we.quantity, we.unit_code, we.reason_code, we.note,
    we.recorded_by_app_user_id,
    we.recorded_at, we.inventory_movement_id, we.cycle_count_id, we.cycle_count_line_id
  from public.inventory_waste_events we
  join public.locations loc on loc.id = we.location_id
  join public.inventory_items item on item.id = we.inventory_item_id
  where we.organization_id = p_organization_id and we.id = p_waste_event_id;
$$;

revoke all on function public.get_inventory_waste_detail(uuid, uuid) from public;
grant execute on function public.get_inventory_waste_detail(uuid, uuid) to service_role;
