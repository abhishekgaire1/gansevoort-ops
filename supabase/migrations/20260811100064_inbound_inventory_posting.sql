-- Milestone 2A.4 (part 1 of 2): real inbound inventory posting.
--
-- Extends the EXISTING append-only inventory ledger (inventory_movements /
-- inventory_movement_lines, 20260811100005) -- never a second inventory
-- accounting system. The new movement type is PURCHASE_RECEIPT, taken
-- directly from docs/DATABASE.md's own documented initial movement
-- taxonomy (PURCHASE_RECEIPT / ISSUE_TO_STATION / ...), not a newly
-- invented name.
--
-- Design facts this builds on (verified against the live schema):
-- - enforce_movement_line_measurement (20260811100005) already computes
--   normalized_base_quantity server-side from the item's OWN
--   inventory_item_units config: a fixed-conversion unit multiplies by the
--   confirmed factor and REJECTS a client-supplied measured quantity; a
--   requires_actual_measurement unit REQUIRES the measured quantity and
--   uses it verbatim. Inbound posting therefore inserts only
--   (entered_quantity, entered_unit, measured_base_quantity?) and inherits
--   the exact base-unit semantics 2A.4 requires, from the same code path
--   withdrawals already trust.
-- - Receiving alone NEVER increases inventory: only the explicit posting
--   RPC below creates PURCHASE_RECEIPT movements, and it is
--   service_role-only (server-authoritative), like every other write RPC.
-- - Idempotency backbone: purchase_document_inventory_posting_lines.
--   receipt_line_id is UNIQUE -- the same effective receipt line can never
--   be posted twice, no matter how many times the button/RPC fires;
--   concurrent posts converge via the same catch-unique_violation pattern
--   proven in try_claim_purchase_document_classification_run and
--   record_receipt.

-- ============================================================
-- 1. PURCHASE_RECEIPT movement type
-- ============================================================
alter table public.inventory_movements
  drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in ('ISSUE_TO_STATION', 'PURCHASE_RECEIPT'));

-- Inbound postings always have an accountable posting manager, and are
-- location-level (storage location), never station-level.
alter table public.inventory_movements
  add constraint inventory_movements_purchase_receipt_requires_actor_check
  check (movement_type <> 'PURCHASE_RECEIPT' or performed_by_app_user_id is not null);
alter table public.inventory_movements
  add constraint inventory_movements_purchase_receipt_no_station_check
  check (movement_type <> 'PURCHASE_RECEIPT' or station_id is null);

-- ============================================================
-- 2. Durable receipt -> movement link (posting records)
-- ============================================================
-- Composite-FK org-safety pattern throughout (project standard): every
-- cross-entity FK carries organization_id.
create unique index receipt_lines_id_org_key on public.receipt_lines (id, organization_id);

create table public.purchase_document_inventory_postings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  posted_by_app_user_id uuid not null,
  posted_at timestamptz not null default now(),
  constraint pd_inventory_postings_pd_org_fk foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  constraint pd_inventory_postings_actor_org_fk foreign key (posted_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint pd_inventory_postings_id_org_key unique (id, organization_id)
);

create index pd_inventory_postings_pd_idx
  on public.purchase_document_inventory_postings (organization_id, purchase_document_id);

create table public.purchase_document_inventory_posting_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  posting_id uuid not null,
  -- THE idempotency backbone: one posting per effective receipt line,
  -- ever. receipt_lines is append-only (never delete/reinsert -- unlike
  -- purchase_document_lines), so a hard FK is safe and correct here.
  receipt_line_id uuid not null unique,
  movement_id uuid not null,
  movement_line_id uuid not null,
  -- Read-convenience denormalization for the VERIFIED page's posting
  -- section; the authoritative quantities remain the movement line's own
  -- (trigger-computed) values, which these are copied from post-insert.
  inventory_item_id uuid not null,
  location_id uuid not null,
  posted_base_quantity numeric not null,
  base_unit_id uuid not null references public.units (id),
  created_at timestamptz not null default now(),
  constraint pd_inventory_posting_lines_qty_check check (posted_base_quantity > 0),
  constraint pd_inventory_posting_lines_posting_org_fk foreign key (posting_id, organization_id)
    references public.purchase_document_inventory_postings (id, organization_id),
  constraint pd_inventory_posting_lines_receipt_line_org_fk foreign key (receipt_line_id, organization_id)
    references public.receipt_lines (id, organization_id),
  constraint pd_inventory_posting_lines_movement_org_fk foreign key (movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint pd_inventory_posting_lines_movement_line_fk foreign key (movement_line_id, movement_id)
    references public.inventory_movement_lines (id, movement_id),
  constraint pd_inventory_posting_lines_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint pd_inventory_posting_lines_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
);

create index pd_inventory_posting_lines_posting_idx
  on public.purchase_document_inventory_posting_lines (posting_id);

-- Posting records are historical facts -- append-only like the ledger
-- itself. Future corrections are append-only adjustments/reversals (a
-- later milestone), never edits to these rows.
create trigger pd_inventory_postings_forbid_update
  before update on public.purchase_document_inventory_postings
  for each row execute function public.forbid_update_delete();
create trigger pd_inventory_postings_forbid_delete
  before delete on public.purchase_document_inventory_postings
  for each row execute function public.forbid_update_delete();
create trigger pd_inventory_posting_lines_forbid_update
  before update on public.purchase_document_inventory_posting_lines
  for each row execute function public.forbid_update_delete();
create trigger pd_inventory_posting_lines_forbid_delete
  before delete on public.purchase_document_inventory_posting_lines
  for each row execute function public.forbid_update_delete();

alter table public.purchase_document_inventory_postings enable row level security;
alter table public.purchase_document_inventory_posting_lines enable row level security;

-- ============================================================
-- 3. Full-stock reference (visualization baseline, NOT ledger truth)
-- ============================================================
-- Append-only history: the CURRENT reference for an item+location is the
-- most recent row. This gives requirement 19's full audit (who/old/new/
-- when/source) structurally, with no update triggers to maintain.
create table public.inventory_stock_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  inventory_item_id uuid not null,
  location_id uuid not null,
  full_quantity numeric not null,
  base_unit_id uuid not null references public.units (id),
  source text not null,
  set_by_app_user_id uuid not null,
  -- Traceability for RESTOCK rows: which posting reset this reference.
  source_posting_id uuid,
  created_at timestamptz not null default now(),
  constraint inventory_stock_references_qty_check check (full_quantity > 0),
  constraint inventory_stock_references_source_check check (source in ('RESTOCK', 'MANAGER_OVERRIDE')),
  constraint inventory_stock_references_restock_posting_check
    check ((source = 'RESTOCK') = (source_posting_id is not null)),
  constraint inventory_stock_references_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint inventory_stock_references_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id),
  constraint inventory_stock_references_actor_org_fk foreign key (set_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint inventory_stock_references_posting_org_fk foreign key (source_posting_id, organization_id)
    references public.purchase_document_inventory_postings (id, organization_id)
);

create index inventory_stock_references_current_idx
  on public.inventory_stock_references (organization_id, inventory_item_id, location_id, created_at desc);

create trigger inventory_stock_references_forbid_update
  before update on public.inventory_stock_references
  for each row execute function public.forbid_update_delete();
create trigger inventory_stock_references_forbid_delete
  before delete on public.inventory_stock_references
  for each row execute function public.forbid_update_delete();

alter table public.inventory_stock_references enable row level security;

-- ============================================================
-- 4. Item + location balances, derived from the ledger
-- ============================================================
-- There is NO mutable current_quantity column anywhere -- balance is
-- always a sum over movement semantics (PURCHASE_RECEIPT = +normalized,
-- ISSUE_TO_STATION = -normalized).
--
-- LOCATION-ALLOCATION RULE (a deliberate V1 design decision, documented
-- for the report): inbound movements carry the receipt line's STORAGE
-- location. Kiosk withdrawals, however, are recorded at the STATION's
-- operating location (the WTC location) -- V1's kiosk deliberately does
-- not ask which storage location stock was pulled from (docs/ROADMAP.md:
-- live station-level balances are explicitly deferred). To keep
-- item+location balances truthful AND make withdrawals visibly reduce
-- storage-location stock, outbound quantity for an item is allocated
-- across that item's INBOUND storage locations proportionally to their
-- inbound share. With a single stocked location (the overwhelmingly
-- common V1 case) this is exact: all outbound reduces that location.
-- With multiple stocked locations it is a deterministic pro-rata
-- approximation, clearly reported as such. The ledger itself stays
-- exactly truthful; this is a read-model presentation rule.
create or replace function public.inventory_location_balances(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_location_id uuid,
  out_inbound_quantity numeric,
  out_allocated_outbound_quantity numeric,
  out_balance numeric
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
       and m.movement_type = 'PURCHASE_RECEIPT'
     group by ml.inventory_item_id, m.location_id
  ),
  inbound_totals as (
    select inventory_item_id, sum(qty) as total_qty from inbound group by inventory_item_id
  ),
  outbound as (
    select ml.inventory_item_id, sum(ml.normalized_base_quantity) as qty
      from public.inventory_movement_lines ml
      join public.inventory_movements m on m.id = ml.movement_id
     where m.organization_id = p_organization_id
       and m.movement_type = 'ISSUE_TO_STATION'
     group by ml.inventory_item_id
  )
  select
    i.inventory_item_id,
    i.location_id,
    i.qty,
    coalesce(o.qty, 0) * i.qty / t.total_qty,
    i.qty - (coalesce(o.qty, 0) * i.qty / t.total_qty)
  from inbound i
  join inbound_totals t on t.inventory_item_id = i.inventory_item_id
  left join outbound o on o.inventory_item_id = i.inventory_item_id;
$$;

revoke all on function public.inventory_location_balances(uuid) from public;
grant execute on function public.inventory_location_balances(uuid) to service_role;

-- The inventory page's one-call read model: balances joined with each
-- item+location's CURRENT (latest) full-stock reference and display names.
create or replace function public.list_inventory_balances(p_organization_id uuid)
returns table (
  out_inventory_item_id uuid,
  out_item_name text,
  out_location_id uuid,
  out_location_name text,
  out_base_unit_code text,
  out_balance numeric,
  out_full_reference_quantity numeric,
  out_reference_source text,
  out_reference_set_at timestamptz
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
    ref.created_at
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
-- 5. Posting status derivation
-- ============================================================
-- NEVER inferred from purchase_document.status, receipt existence, or
-- receiving completeness -- only from actual posting records. "Required"
-- lines are the effective receipt lines that represent real physical
-- inventory: CONFIRMED INVENTORY classification, received quantity > 0
-- (a fully-not-received/shorted line documents a shortage and neither
-- needs nor gets a movement).
create or replace function public.purchase_document_inventory_posting_status(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns table (
  out_status text,
  out_required_line_count integer,
  out_posted_line_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with required as (
    select rl.id,
           (pl.id is not null) as posted
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
     where rl.matched_line_key is not null
       and rl.actual_received_package_quantity is not null
       and rl.actual_received_package_quantity > 0
  )
  select
    case
      when count(*) filter (where posted) = 0 then 'NOT_POSTED'
      when count(*) filter (where not posted) > 0 then 'PARTIALLY_POSTED'
      else 'POSTED'
    end,
    count(*)::integer,
    (count(*) filter (where posted))::integer
  from required;
$$;

revoke all on function public.purchase_document_inventory_posting_status(uuid, uuid) from public;
grant execute on function public.purchase_document_inventory_posting_status(uuid, uuid) to service_role;

-- ============================================================
-- 6. The posting RPC -- the ONLY thing that increases inventory
-- ============================================================
create or replace function public.post_purchase_document_inventory(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid
)
returns table (
  out_status text,
  out_posting_id uuid,
  out_posted_line_count integer,
  out_movement_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_status text;
  v_blockers jsonb;
  v_candidate record;
  v_location record;
  v_posting_id uuid;
  v_movement_id uuid;
  v_movement_line_id uuid;
  v_movement_count integer := 0;
  v_posted_count integer := 0;
  v_already_posted_count integer;
  v_affected record;
  v_new_balance numeric;
begin
  select status into v_doc_status
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_doc_status is null then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_doc_status <> 'VERIFIED' then
    raise exception 'purchase_document % is % and cannot be posted to inventory -- only a VERIFIED document can post', p_purchase_document_id, v_doc_status
      using errcode = 'GA003';
  end if;

  -- Blocker scan: every UNPOSTED effective inventory line must be fully
  -- postable, or the whole operation is refused with the exact reasons
  -- (atomic all-required-lines posting -- no accidental partial posting).
  select jsonb_agg(jsonb_build_object('lineKey', b.line_key, 'description', b.description, 'reason', b.reason))
    into v_blockers
  from (
    select rl.matched_line_key as line_key,
           coalesce(rl.description_snapshot, 'Line') as description,
           case
             when c.inventory_item_id is null then 'canonical inventory item is not resolved'
             when rl.actual_received_package_quantity is null then 'received quantity has not been recorded'
             when rl.location_id is null then 'storage location is missing'
             when rl.actual_received_package_unit is null then 'received unit is missing'
             when u.id is null then 'received unit "' || rl.actual_received_package_unit || '" is not a recognized unit'
             when iiu.id is null then 'received unit "' || rl.actual_received_package_unit || '" is not configured for this item'
             when iiu.requires_actual_measurement and rl.actual_verified_base_quantity is null
               then 'verified measurement is required -- this item varies by delivery'
             when not iiu.requires_actual_measurement and rl.actual_verified_base_quantity is not null
                  and rl.actual_verified_base_quantity <> rl.actual_received_package_quantity * iiu.conversion_factor
               then 'stored verified quantity is inconsistent with the item''s current confirmed conversion -- review before posting'
             else null
           end as reason
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.inventory_items ii
        on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
      left join public.units u
        on upper(btrim(u.code)) = upper(btrim(coalesce(rl.actual_received_package_unit, '')))
      left join public.inventory_item_units iiu
        on iiu.inventory_item_id = c.inventory_item_id and iiu.unit_id = u.id and iiu.is_active
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
     where rl.matched_line_key is not null
       and pl.id is null
       and (rl.actual_received_package_quantity is null or rl.actual_received_package_quantity > 0)
  ) b
  where b.reason is not null;

  if v_blockers is not null then
    raise exception 'cannot post inventory yet -- % line(s) are not postable', jsonb_array_length(v_blockers)
      using errcode = 'GA017', detail = v_blockers::text;
  end if;

  -- Idempotent replay: nothing left to post means everything already
  -- posted -- return the existing (latest) posting, never a duplicate.
  select count(*) into v_already_posted_count
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id;

  if not exists (
    select 1
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id
      join public.purchase_document_line_classifications c
        on c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and c.line_key = rl.matched_line_key
       and c.status = 'CONFIRMED'
       and c.disposition = 'INVENTORY'
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
     where rl.matched_line_key is not null
       and pl.id is null
       and rl.actual_received_package_quantity > 0
  ) then
    if v_already_posted_count > 0 then
      select id into v_posting_id
        from public.purchase_document_inventory_postings
       where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
       order by posted_at desc limit 1;
      return query select 'ALREADY_POSTED'::text, v_posting_id, 0, 0;
      return;
    end if;
    raise exception 'purchase_document % has no postable inventory lines', p_purchase_document_id
      using errcode = 'GA017';
  end if;

  -- All checks passed -- post atomically. The unique receipt_line_id
  -- backstop makes two concurrent posts converge: the loser's entire
  -- posting work rolls back (this EXCEPTION block is a subtransaction)
  -- and it reports the winner's posting instead.
  begin
    insert into public.purchase_document_inventory_postings (organization_id, purchase_document_id, posted_by_app_user_id)
    values (p_organization_id, p_purchase_document_id, p_app_user_id)
    returning id into v_posting_id;

    -- One movement per distinct storage location in this posting.
    for v_location in
      select distinct rl.location_id, loc.timezone
        from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
        join public.receipt_lines rl on rl.receipt_id = er.id
        join public.purchase_document_line_classifications c
          on c.organization_id = p_organization_id
         and c.purchase_document_id = p_purchase_document_id
         and c.line_key = rl.matched_line_key
         and c.status = 'CONFIRMED'
         and c.disposition = 'INVENTORY'
        join public.locations loc on loc.id = rl.location_id
        left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
       where rl.matched_line_key is not null
         and pl.id is null
         and rl.actual_received_package_quantity > 0
    loop
      insert into public.inventory_movements (
        organization_id, location_id, station_id, movement_type,
        performed_by_app_user_id, business_date
      ) values (
        p_organization_id, v_location.location_id, null, 'PURCHASE_RECEIPT',
        p_app_user_id, (now() at time zone v_location.timezone)::date
      ) returning id into v_movement_id;
      v_movement_count := v_movement_count + 1;

      for v_candidate in
        select rl.id as receipt_line_id,
               c.inventory_item_id,
               rl.actual_received_package_quantity as entered_quantity,
               u.id as entered_unit_id,
               iiu.requires_actual_measurement,
               rl.actual_verified_base_quantity
          from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
          join public.receipt_lines rl on rl.receipt_id = er.id
          join public.purchase_document_line_classifications c
            on c.organization_id = p_organization_id
           and c.purchase_document_id = p_purchase_document_id
           and c.line_key = rl.matched_line_key
           and c.status = 'CONFIRMED'
           and c.disposition = 'INVENTORY'
          join public.units u on upper(btrim(u.code)) = upper(btrim(rl.actual_received_package_unit))
          join public.inventory_item_units iiu
            on iiu.inventory_item_id = c.inventory_item_id and iiu.unit_id = u.id and iiu.is_active
          left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
         where rl.matched_line_key is not null
           and pl.id is null
           and rl.actual_received_package_quantity > 0
           and rl.location_id = v_location.location_id
      loop
        -- enforce_movement_line_measurement computes organization_id,
        -- base_unit_id, and normalized_base_quantity authoritatively --
        -- fixed conversions are recomputed from the item's CURRENT
        -- confirmed factor (never a stale client value), and measured
        -- items use the manager's verified actual quantity.
        insert into public.inventory_movement_lines (
          movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
        ) values (
          v_movement_id, v_candidate.inventory_item_id, v_candidate.entered_quantity, v_candidate.entered_unit_id,
          case when v_candidate.requires_actual_measurement then v_candidate.actual_verified_base_quantity else null end
        ) returning id into v_movement_line_id;

        insert into public.purchase_document_inventory_posting_lines (
          organization_id, posting_id, receipt_line_id, movement_id, movement_line_id,
          inventory_item_id, location_id, posted_base_quantity, base_unit_id
        )
        select p_organization_id, v_posting_id, v_candidate.receipt_line_id, v_movement_id, ml.id,
               ml.inventory_item_id, v_location.location_id, ml.normalized_base_quantity, ml.base_unit_id
          from public.inventory_movement_lines ml
         where ml.id = v_movement_line_id;

        v_posted_count := v_posted_count + 1;
      end loop;
    end loop;

    -- Every genuine restock sets the POST-RESTOCK balance as the new 100%
    -- reference for each affected item+location (product rule 13). The
    -- balance function sees this transaction's own uncommitted rows.
    for v_affected in
      select distinct pl.inventory_item_id, pl.location_id, pl.base_unit_id
        from public.purchase_document_inventory_posting_lines pl
       where pl.posting_id = v_posting_id
    loop
      select b.out_balance into v_new_balance
        from public.inventory_location_balances(p_organization_id) b
       where b.out_inventory_item_id = v_affected.inventory_item_id
         and b.out_location_id = v_affected.location_id;

      if v_new_balance is not null and v_new_balance > 0 then
        insert into public.inventory_stock_references (
          organization_id, inventory_item_id, location_id, full_quantity, base_unit_id,
          source, set_by_app_user_id, source_posting_id
        ) values (
          p_organization_id, v_affected.inventory_item_id, v_affected.location_id, v_new_balance, v_affected.base_unit_id,
          'RESTOCK', p_app_user_id, v_posting_id
        );
      end if;
    end loop;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_app_user_id, 'INVENTORY_POSTED', 'purchase_document', p_purchase_document_id,
      jsonb_build_object('postingId', v_posting_id, 'postedLineCount', v_posted_count, 'movementCount', v_movement_count));

  exception when unique_violation then
    -- A concurrent post won the race on receipt_line_id -- everything this
    -- caller inserted above is rolled back; report the winner's posting.
    select id into v_posting_id
      from public.purchase_document_inventory_postings
     where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
     order by posted_at desc limit 1;
    return query select 'ALREADY_POSTED'::text, v_posting_id, 0, 0;
    return;
  end;

  return query select 'POSTED'::text, v_posting_id, v_posted_count, v_movement_count;
end;
$$;

revoke all on function public.post_purchase_document_inventory(uuid, uuid, uuid) from public;
grant execute on function public.post_purchase_document_inventory(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 7. Manager full-reference override
-- ============================================================
-- Changes ONLY the visualization/reorder baseline. Never creates an
-- inventory movement, never changes any balance, never rewrites history
-- (append-only row + audit event). The next genuine restock supersedes it
-- automatically, simply by appending a newer RESTOCK row.
create or replace function public.set_inventory_stock_reference(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_location_id uuid,
  p_full_quantity numeric,
  p_app_user_id uuid
)
returns table (out_reference_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_unit_id uuid;
  v_previous numeric;
  v_reference_id uuid;
begin
  if p_full_quantity is null or p_full_quantity <= 0 then
    raise exception 'full reference quantity must be a positive number';
  end if;

  select base_unit_id into v_base_unit_id
    from public.inventory_items
   where id = p_inventory_item_id and organization_id = p_organization_id and approval_status = 'CONFIRMED';

  if v_base_unit_id is null then
    raise exception 'inventory_item % is not a confirmed item in this organization', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  if not exists (select 1 from public.locations where id = p_location_id and organization_id = p_organization_id) then
    raise exception 'location % not found in this organization', p_location_id;
  end if;

  select full_quantity into v_previous
    from public.inventory_stock_references
   where organization_id = p_organization_id
     and inventory_item_id = p_inventory_item_id
     and location_id = p_location_id
   order by created_at desc, id desc limit 1;

  insert into public.inventory_stock_references (
    organization_id, inventory_item_id, location_id, full_quantity, base_unit_id,
    source, set_by_app_user_id, source_posting_id
  ) values (
    p_organization_id, p_inventory_item_id, p_location_id, p_full_quantity, v_base_unit_id,
    'MANAGER_OVERRIDE', p_app_user_id, null
  ) returning id into v_reference_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'STOCK_REFERENCE_OVERRIDDEN', 'inventory_item', p_inventory_item_id,
    jsonb_build_object('locationId', p_location_id, 'fullQuantity', v_previous),
    jsonb_build_object('locationId', p_location_id, 'fullQuantity', p_full_quantity, 'source', 'MANAGER_OVERRIDE'));

  return query select v_reference_id;
end;
$$;

revoke all on function public.set_inventory_stock_reference(uuid, uuid, uuid, numeric, uuid) from public;
grant execute on function public.set_inventory_stock_reference(uuid, uuid, uuid, numeric, uuid) to service_role;
