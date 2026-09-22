-- Line-treatment classification model (Review Invoice / Items & Receiving /
-- Review & Post rebuild).
--
-- WHY: the previous model classified every invoice line as INVENTORY or
-- NON_INVENTORY only, and the only way to record a NON_INVENTORY decision
-- was to create a (pending) inventory_items row for it. A vendor credit
-- such as "CASES RETURNED" therefore became a proposed NEW ITEM named
-- "Cases Returned", entered the New Items Found flow, and -- because the
-- classifier had no concept of "credit" -- carried no expense category.
-- Tax, freight, discounts and credits all have different data
-- requirements, posting effects and manager actions; "non-inventory" is
-- not an operational classification.
--
-- THE MODEL (one authoritative, server-validated line treatment):
--   INVENTORY_PURCHASE  -> canonical item + package + receiving -> positive
--                          PURCHASE_RECEIPT movement (unchanged path)
--   EXPENSE             -> active expense (spend) category, no item, no
--                          inventory movement
--   FREIGHT_FEE         -> like EXPENSE (delivery/fuel/service charges)
--   TAX                 -> document-level tax, no category, no inventory
--   DISCOUNT            -> line/document scope, totals only
--   CREDIT_RETURN       -> requires credit_subtype:
--        FINANCIAL_CREDIT            no item, reduces invoice total
--        RETURNABLE_CONTAINER_CREDIT no item, no movement by default
--        INVENTORY_RETURN            canonical item + qty + unit + source
--                                    location + reason -> audited negative
--                                    VENDOR_RETURN movement at posting
--   UNRESOLVED          -> never postable; blocks Step 2/3 and posting
--
-- disposition (INVENTORY/NON_INVENTORY/UNRESOLVED) is KEPT as the derived
-- coarse view every existing consumer already reads (posting scans,
-- expense reporting, receiving config). A BEFORE trigger keeps the two
-- columns consistent in both directions so the existing writers (which
-- only know disposition) and the new writers (which set line_treatment)
-- can never disagree; a CHECK constraint makes a disagreement impossible
-- to persist.
--
-- Conventions: SECURITY DEFINER + set search_path = '' + full schema
-- qualification, composite (id, organization_id) FKs, audit_events on
-- every manager decision, GA0xx codes (docs/ERROR_CODES.md), revoke/grant
-- to service_role, forward-only.

-- ============================================================
-- 1. purchase_document_line_classifications: treatment columns
-- ============================================================
alter table public.purchase_document_line_classifications
  add column line_treatment text not null default 'UNRESOLVED',
  add column credit_subtype text,
  add column discount_scope text,
  add column discount_related_line_key uuid,
  add column return_quantity numeric,
  add column return_unit_code text,
  add column return_location_id uuid,
  add column return_reason text,
  add column return_impact_acknowledged boolean not null default false,
  add column ai_proposed_treatment text,
  add column ai_proposed_credit_subtype text,
  add column ai_proposed_spend_category_id uuid,
  add column ai_reason text,
  add column ai_evidence jsonb,
  add column ai_review_fields jsonb,
  add column treatment_rule_id uuid;

-- Backfill from the coarse disposition every existing row already carries.
-- Rows belonging to VERIFIED / DISCARDED documents are protected by the
-- lock trigger (20260811100056); this one-time, meaning-preserving
-- derivation (it changes no business fact -- the treatment IS what the
-- disposition already meant) is the only legitimate exception, so the lock
-- trigger is suspended for exactly this statement and re-enabled
-- immediately after. The updated_at trigger is suspended too so the
-- backfill never masquerades as a manager edit.
alter table public.purchase_document_line_classifications disable trigger purchase_document_line_classifications_forbid_when_locked;
alter table public.purchase_document_line_classifications disable trigger purchase_document_line_classifications_set_updated_at;
update public.purchase_document_line_classifications
   set line_treatment = case disposition
                          when 'INVENTORY' then 'INVENTORY_PURCHASE'
                          when 'NON_INVENTORY' then 'EXPENSE'
                          else 'UNRESOLVED'
                        end;
alter table public.purchase_document_line_classifications enable trigger purchase_document_line_classifications_forbid_when_locked;
alter table public.purchase_document_line_classifications enable trigger purchase_document_line_classifications_set_updated_at;

alter table public.purchase_document_line_classifications
  add constraint purchase_document_line_classifications_line_treatment_check
    check (line_treatment in ('INVENTORY_PURCHASE', 'EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE', 'UNRESOLVED')),
  add constraint purchase_document_line_classifications_credit_subtype_check
    check (credit_subtype is null or credit_subtype in ('FINANCIAL_CREDIT', 'RETURNABLE_CONTAINER_CREDIT', 'INVENTORY_RETURN')),
  add constraint purchase_document_line_classifications_credit_subtype_scope_check
    check (credit_subtype is null or line_treatment = 'CREDIT_RETURN'),
  add constraint purchase_document_line_classifications_discount_scope_check
    check (discount_scope is null or discount_scope in ('LINE', 'DOCUMENT')),
  add constraint purchase_document_line_classifications_return_quantity_check
    check (return_quantity is null or return_quantity > 0),
  add constraint purchase_document_line_classifications_ai_proposed_treatment_check
    check (ai_proposed_treatment is null or ai_proposed_treatment in ('INVENTORY_PURCHASE', 'EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE', 'UNRESOLVED')),
  -- treatment and disposition can never disagree
  add constraint purchase_document_line_classifications_treatment_disposition_check
    check ((line_treatment = 'INVENTORY_PURCHASE') = (disposition = 'INVENTORY')
       and (line_treatment = 'UNRESOLVED') = (disposition = 'UNRESOLVED')),
  add constraint purchase_document_line_classifications_return_location_org_fk
    foreign key (return_location_id, organization_id) references public.locations (id, organization_id),
  add constraint purchase_document_line_classifications_ai_spend_category_org_fk
    foreign key (ai_proposed_spend_category_id, organization_id) references public.spend_categories (id, organization_id);

-- Keep line_treatment <-> disposition consistent in BOTH directions. The
-- pre-existing writers (record_ai_suggested_candidate, record_ai_item_
-- proposal, approve_line_classification_*, bulk_confirm, the deterministic
-- resolver) only ever set disposition; the new treatment writers set
-- line_treatment. Whichever column a statement changes wins, and the other
-- is derived from it, so every writer stays correct without being
-- rewritten. NON_INVENTORY on its own is ambiguous (expense? credit? tax?):
-- a disposition-only write onto a row that already holds a specific
-- non-inventory treatment keeps that treatment; a fresh NON_INVENTORY row
-- defaults to EXPENSE (the previous model's only meaning of the word).
create or replace function public.sync_line_treatment_disposition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.line_treatment = 'UNRESOLVED' and new.disposition <> 'UNRESOLVED' then
      new.line_treatment := case new.disposition when 'INVENTORY' then 'INVENTORY_PURCHASE' else 'EXPENSE' end;
    elsif new.line_treatment <> 'UNRESOLVED' then
      new.disposition := case new.line_treatment when 'INVENTORY_PURCHASE' then 'INVENTORY' else 'NON_INVENTORY' end;
    end if;
    return new;
  end if;

  if new.line_treatment is distinct from old.line_treatment then
    new.disposition := case new.line_treatment
                         when 'INVENTORY_PURCHASE' then 'INVENTORY'
                         when 'UNRESOLVED' then 'UNRESOLVED'
                         else 'NON_INVENTORY'
                       end;
  elsif new.disposition is distinct from old.disposition then
    new.line_treatment := case new.disposition
                            when 'INVENTORY' then 'INVENTORY_PURCHASE'
                            when 'UNRESOLVED' then 'UNRESOLVED'
                            else (case when old.line_treatment in ('EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE') then old.line_treatment else 'EXPENSE' end)
                          end;
  end if;
  -- A non-credit treatment can never carry a credit subtype.
  if new.line_treatment <> 'CREDIT_RETURN' then
    new.credit_subtype := null;
  end if;
  return new;
end;
$$;

create trigger purchase_document_line_classifications_sync_treatment
  before insert or update on public.purchase_document_line_classifications
  for each row execute function public.sync_line_treatment_disposition();

-- Two new resolution sources: a vendor-specific prior decision
-- ("Matched previous decision") and a high-confidence AI/rule proposal the
-- manager accepted by progressing/posting with it visible ("AI assigned").
alter table public.purchase_document_line_classifications
  drop constraint purchase_document_line_classifications_resolution_source_check;
alter table public.purchase_document_line_classifications
  add constraint purchase_document_line_classifications_resolution_source_check
    check (resolution_source in ('VENDOR_SKU_MAPPING', 'VENDOR_DESCRIPTION_MAPPING', 'NORMALIZED_NAME_MATCH', 'AI_SUGGESTED', 'MANUAL', 'VENDOR_TREATMENT_RULE', 'AI_ACCEPTED'));

-- ============================================================
-- 2. vendor_line_treatment_rules -- organization-scoped, vendor-specific
--    prior decisions for NON-item lines (the item-side analogue is
--    vendor_item_mappings, which maps a SKU/description to a canonical
--    item; a treatment rule maps it to a treatment + category/subtype and
--    deliberately never to an item). Auditable, admin-editable
--    (deactivate), never cross-organization (composite FKs), and a rule
--    whose expense category has been deactivated is ignored at match time.
-- ============================================================
create table public.vendor_line_treatment_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  vendor_id uuid not null,
  vendor_sku text,
  normalized_description text,
  line_treatment text not null,
  credit_subtype text,
  spend_category_id uuid,
  discount_scope text,
  is_active boolean not null default true,
  created_by_app_user_id uuid not null,
  source_purchase_document_id uuid,
  source_line_key uuid,
  deactivated_by_app_user_id uuid,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_line_treatment_rules_treatment_check
    check (line_treatment in ('EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE')),
  constraint vendor_line_treatment_rules_credit_subtype_check
    check (credit_subtype is null or credit_subtype in ('FINANCIAL_CREDIT', 'RETURNABLE_CONTAINER_CREDIT', 'INVENTORY_RETURN')),
  constraint vendor_line_treatment_rules_discount_scope_check
    check (discount_scope is null or discount_scope in ('LINE', 'DOCUMENT')),
  constraint vendor_line_treatment_rules_key_check
    check (vendor_sku is not null or normalized_description is not null),
  constraint vendor_line_treatment_rules_id_org_key unique (id, organization_id),
  constraint vendor_line_treatment_rules_vendor_org_fk foreign key (vendor_id, organization_id)
    references public.vendors (id, organization_id),
  constraint vendor_line_treatment_rules_spend_category_org_fk foreign key (spend_category_id, organization_id)
    references public.spend_categories (id, organization_id),
  constraint vendor_line_treatment_rules_created_by_org_fk foreign key (created_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint vendor_line_treatment_rules_deactivated_by_org_fk foreign key (deactivated_by_app_user_id, organization_id)
    references public.app_users (id, organization_id),
  constraint vendor_line_treatment_rules_source_document_org_fk foreign key (source_purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id)
);

create unique index vendor_line_treatment_rules_active_sku_key
  on public.vendor_line_treatment_rules (organization_id, vendor_id, vendor_sku)
  where is_active and vendor_sku is not null;
create unique index vendor_line_treatment_rules_active_description_key
  on public.vendor_line_treatment_rules (organization_id, vendor_id, normalized_description)
  where is_active and vendor_sku is null and normalized_description is not null;
create index vendor_line_treatment_rules_org_vendor_idx
  on public.vendor_line_treatment_rules (organization_id, vendor_id);

create trigger vendor_line_treatment_rules_set_updated_at
  before update on public.vendor_line_treatment_rules
  for each row execute function public.set_updated_at();

alter table public.vendor_line_treatment_rules enable row level security;
-- Deny-by-default: no policies for anon/authenticated.

alter table public.purchase_document_line_classifications
  add constraint purchase_document_line_classifications_treatment_rule_org_fk
    foreign key (treatment_rule_id, organization_id) references public.vendor_line_treatment_rules (id, organization_id);

-- The same normalization the deterministic item resolver uses in TS
-- (normalizeDescription: trim, collapse whitespace, uppercase), so a rule
-- keyed on a description matches exactly what the classifier looks up.
create or replace function public.normalize_line_description(p_description text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_description, '')), '\s+', ' ', 'g')), '');
$$;

-- ============================================================
-- 3. VENDOR_RETURN movement type -- an audited outbound movement for
--    tracked merchandise physically returned to a vendor, posted from an
--    INVENTORY_RETURN credit line. Never a negative receipt, never a
--    signed quantity (product rule: business meaning comes from the
--    explicit movement type). Outbound in every balance formula below --
--    all four ledger formulas are re-issued together so they stay in
--    lockstep (the same discipline 20260811100136 applied for the
--    INVENTORY_CORRECTION_* types).
-- ============================================================
alter table public.inventory_movements
  drop constraint inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
    check (movement_type in (
      'PURCHASE_RECEIPT', 'ISSUE_TO_STATION',
      'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE',
      'COUNT_ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_OUT',
      'INVENTORY_CORRECTION_IN', 'INVENTORY_CORRECTION_OUT',
      'VENDOR_RETURN'
    )),
  add constraint inventory_movements_vendor_return_requires_actor_check
    check (movement_type <> 'VENDOR_RETURN' or performed_by_app_user_id is not null),
  add constraint inventory_movements_vendor_return_no_station_check
    check (movement_type <> 'VENDOR_RETURN' or station_id is null);

-- Links a VENDOR_RETURN movement to the posting + credit line it came from
-- (the return-side analogue of purchase_document_inventory_posting_lines;
-- classification_id UNIQUE is the idempotency backbone, exactly like
-- receipt_line_id there).
create table public.purchase_document_inventory_return_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  posting_id uuid not null,
  classification_id uuid not null unique,
  line_key uuid not null,
  movement_id uuid not null,
  movement_line_id uuid not null,
  inventory_item_id uuid not null,
  location_id uuid not null,
  posted_base_quantity numeric not null,
  base_unit_id uuid not null references public.units (id),
  created_at timestamptz not null default now(),
  constraint purchase_document_inventory_return_lines_qty_check check (posted_base_quantity > 0),
  constraint purchase_document_inventory_return_lines_posting_org_fk foreign key (posting_id, organization_id)
    references public.purchase_document_inventory_postings (id, organization_id),
  constraint purchase_document_inventory_return_lines_classification_fk foreign key (classification_id)
    references public.purchase_document_line_classifications (id),
  constraint purchase_document_inventory_return_lines_movement_org_fk foreign key (movement_id, organization_id)
    references public.inventory_movements (id, organization_id),
  constraint purchase_document_inventory_return_lines_movement_line_fk foreign key (movement_line_id, movement_id)
    references public.inventory_movement_lines (id, movement_id),
  constraint purchase_document_inventory_return_lines_item_org_fk foreign key (inventory_item_id, organization_id)
    references public.inventory_items (id, organization_id),
  constraint purchase_document_inventory_return_lines_location_org_fk foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
);

create index purchase_document_inventory_return_lines_posting_idx
  on public.purchase_document_inventory_return_lines (posting_id);

create trigger purchase_document_inventory_return_lines_forbid_update
  before update on public.purchase_document_inventory_return_lines
  for each row execute function public.forbid_update_delete();
create trigger purchase_document_inventory_return_lines_forbid_delete
  before delete on public.purchase_document_inventory_return_lines
  for each row execute function public.forbid_update_delete();

alter table public.purchase_document_inventory_return_lines enable row level security;

-- A CONFIRMED classification that has been posted as a return may never be
-- deleted out from under its ledger link (same protection the posting
-- lines' FK to receipt_lines gives receipts).

-- 3a. Ledger formulas re-issued with VENDOR_RETURN as an outbound type.
--     Bodies reproduced verbatim from 20260811100136 with ONLY the
--     outbound movement_type list extended (VENDOR_RETURN is exact-
--     location outbound, like WASTE).
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
         and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT', 'VENDOR_RETURN')
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
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT', 'VENDOR_RETURN')
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
       and m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT', 'VENDOR_RETURN')
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
                  and m2.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT', 'VENDOR_RETURN')
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

-- 3b. location_has_stock (20260811100180) -- same outbound extension.
create or replace function public.location_has_stock(
  p_organization_id uuid,
  p_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from (
        select ml.inventory_item_id,
               sum(
                 case
                   when m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'COUNT_ADJUSTMENT_IN', 'INVENTORY_CORRECTION_IN')
                     then ml.normalized_base_quantity
                   when m.movement_type in ('ISSUE_TO_STATION', 'TRANSFER_OUT', 'WASTE', 'COUNT_ADJUSTMENT_OUT', 'INVENTORY_CORRECTION_OUT', 'VENDOR_RETURN')
                        and m.location_attribution = 'EXACT'
                     then -ml.normalized_base_quantity
                   else 0
                 end
               ) as net
          from public.inventory_movement_lines ml
          join public.inventory_movements m on m.id = ml.movement_id
         where m.organization_id = p_organization_id
           and m.location_id = p_location_id
         group by ml.inventory_item_id
      ) b
     where b.net > 0
  );
$$;

-- ============================================================
-- 4. Shared treatment validation -- ONE definition used by the
--    completeness gate, the posting-blocker read model, the manager
--    decision RPC, the acceptance RPC and the posting RPC itself.
-- ============================================================

-- The base-unit quantity an INVENTORY_RETURN line would remove: the
-- returned unit must be the item's own base unit, or an ACTIVE fixed-
-- conversion unit configured for that item. Null when not resolvable
-- (never a guessed factor).
create or replace function public.line_return_base_quantity(p_classification_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when u.id is null then null
           when u.id = ii.base_unit_id then c.return_quantity
           when iiu.id is not null and iiu.is_active and iiu.conversion_factor is not null and not iiu.requires_actual_measurement
             then c.return_quantity * iiu.conversion_factor
           else null
         end
    from public.purchase_document_line_classifications c
    join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = c.organization_id
    left join public.units u on upper(btrim(u.code)) = upper(btrim(coalesce(c.return_unit_code, '')))
    left join public.inventory_item_units iiu on iiu.inventory_item_id = ii.id and iiu.unit_id = u.id
   where c.id = p_classification_id
     and c.return_quantity is not null;
$$;

revoke all on function public.line_return_base_quantity(uuid) from public;
grant execute on function public.line_return_base_quantity(uuid) to service_role;

-- Null when the classification's treatment-specific fields are complete
-- and valid; otherwise the ONE plain-language reason. Deliberately says
-- nothing about status/confirmation -- callers combine it with status.
create or replace function public.line_classification_treatment_issue(p_classification_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when c.line_treatment = 'UNRESOLVED' then 'line has not been classified'
           when c.line_treatment in ('EXPENSE', 'FREIGHT_FEE') and c.spend_category_id is null then 'expense category is missing'
           when c.line_treatment in ('EXPENSE', 'FREIGHT_FEE') and not coalesce(sc.is_active, false) then 'expense category is no longer active -- choose another'
           when c.line_treatment in ('EXPENSE', 'FREIGHT_FEE') and sc.requires_explanation and nullif(btrim(coalesce(c.explanation, '')), '') is null
             then 'a written explanation is required for this expense category'
           when c.line_treatment = 'DISCOUNT' and c.discount_scope is null then 'discount scope (line or document) has not been chosen'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype is null then 'credit type has not been chosen -- did tracked inventory physically leave the store?'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and c.inventory_item_id is null then 'returned inventory item is not resolved'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and c.return_quantity is null then 'returned quantity is missing'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and c.return_unit_code is null then 'returned unit is missing'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and c.return_location_id is null then 'source location is missing'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and nullif(btrim(coalesce(c.return_reason, '')), '') is null then 'return reason is missing'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and not c.return_impact_acknowledged then 'inventory-impact acknowledgment is missing'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN' and public.line_return_base_quantity(c.id) is null
             then 'returned unit "' || coalesce(c.return_unit_code, '') || '" is not a configured unit for this item'
           when c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN'
                and public.line_return_base_quantity(c.id) > public.inventory_location_item_balance(c.organization_id, c.inventory_item_id, c.return_location_id)
             then 'returning ' || public.line_return_base_quantity(c.id)::text || ' exceeds the on-hand quantity ('
                  || public.inventory_location_item_balance(c.organization_id, c.inventory_item_id, c.return_location_id)::text || ') at the source location'
           else null
         end
    from public.purchase_document_line_classifications c
    left join public.spend_categories sc on sc.id = c.spend_category_id and sc.organization_id = c.organization_id
   where c.id = p_classification_id;
$$;

revoke all on function public.line_classification_treatment_issue(uuid) from public;
grant execute on function public.line_classification_treatment_issue(uuid) to service_role;

-- The ONE central confidence policy (>= 0.90 = "AI assigned": preselected
-- and accepted by the manager progressing/posting with it visible; no
-- extra click). Only proposals whose required fields are already valid
-- qualify; an INVENTORY_RETURN (moves stock) or a low/medium-confidence
-- proposal never does. Confidence never overrides deterministic
-- validation -- an invalid category disqualifies regardless of score.
create or replace function public.line_classification_is_auto_acceptable(p_classification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.status = 'PENDING_REVIEW'
       and c.resolution_source in ('AI_SUGGESTED', 'VENDOR_TREATMENT_RULE')
       and coalesce(c.ai_confidence, 0) >= 0.9
       and (
         (c.line_treatment in ('EXPENSE', 'FREIGHT_FEE', 'TAX', 'DISCOUNT') and public.line_classification_treatment_issue(c.id) is null)
         or (c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype in ('FINANCIAL_CREDIT', 'RETURNABLE_CONTAINER_CREDIT'))
         or (c.line_treatment = 'INVENTORY_PURCHASE' and c.ai_suggested_inventory_item_id is not null
             and exists (
               select 1 from public.inventory_items ii
                where ii.id = c.ai_suggested_inventory_item_id
                  and ii.organization_id = c.organization_id
                  and ii.approval_status = 'CONFIRMED'
                  and ii.disposition = 'INVENTORY'
             ))
       )
      from public.purchase_document_line_classifications c
     where c.id = p_classification_id
  ), false);
$$;

revoke all on function public.line_classification_is_auto_acceptable(uuid) from public;
grant execute on function public.line_classification_is_auto_acceptable(uuid) to service_role;

-- ============================================================
-- 5. record_ai_line_treatment -- the SYSTEM writer for a non-item
--    treatment proposal (AI or a matched vendor rule). Mirrors
--    record_ai_suggested_candidate's safety: DRAFT/READY parents only,
--    never touches a CONFIRMED line, never CONFIRMS anything itself, no
--    audit (the manager's decision/acceptance is what becomes
--    authoritative). Applies the confidence policy: < 0.70, or an expense
--    without a valid ACTIVE category id, lands as UNRESOLVED with the raw
--    proposal preserved for display -- never an invented category.
-- ============================================================
create or replace function public.record_ai_line_treatment(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_proposed_treatment text,
  p_proposed_credit_subtype text,
  p_proposed_spend_category_id uuid,
  p_ai_confidence numeric,
  p_ai_reason text,
  p_ai_evidence jsonb default null,
  p_ai_review_fields jsonb default null,
  p_resolution_source text default 'AI_SUGGESTED',
  p_treatment_rule_id uuid default null,
  p_discount_scope text default null
)
returns table (out_classification_id uuid, out_applied_treatment text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_status text;
  v_line record;
  v_existing record;
  v_category_id uuid;
  v_effective text;
  v_subtype text;
  v_scope text;
  v_classification_id uuid;
begin
  if p_proposed_treatment not in ('INVENTORY_PURCHASE', 'EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE', 'UNRESOLVED') then
    raise exception 'unknown line treatment %', p_proposed_treatment using errcode = 'GA033';
  end if;
  if p_proposed_credit_subtype is not null and p_proposed_credit_subtype not in ('FINANCIAL_CREDIT', 'RETURNABLE_CONTAINER_CREDIT', 'INVENTORY_RETURN') then
    raise exception 'unknown credit subtype %', p_proposed_credit_subtype using errcode = 'GA033';
  end if;
  if p_resolution_source not in ('AI_SUGGESTED', 'VENDOR_TREATMENT_RULE') then
    raise exception 'unknown system resolution source %', p_resolution_source using errcode = 'GA033';
  end if;
  if p_discount_scope is not null and p_discount_scope not in ('LINE', 'DOCUMENT') then
    raise exception 'unknown discount scope %', p_discount_scope using errcode = 'GA033';
  end if;

  select status into v_parent_status
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;
  if v_parent_status is null then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;
  if v_parent_status not in ('DRAFT', 'READY_FOR_VERIFICATION') then
    raise exception 'purchase_document % is % and cannot accept a system classification write', p_purchase_document_id, v_parent_status
      using errcode = 'GA003';
  end if;

  select id, status into v_existing
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;
  if v_existing.status = 'CONFIRMED' then
    return query select v_existing.id, null::text;
    return;
  end if;

  select vendor_sku, description, package_unit, measured_unit
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;
  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  -- The category is accepted ONLY when it is this organization's own,
  -- currently ACTIVE category id -- a stale, foreign or invented id is
  -- dropped, never saved.
  select id into v_category_id
    from public.spend_categories
   where id = p_proposed_spend_category_id
     and organization_id = p_organization_id
     and is_active;

  v_effective := p_proposed_treatment;
  if coalesce(p_ai_confidence, 0) < 0.7 then
    v_effective := 'UNRESOLVED';
  end if;
  if v_effective in ('EXPENSE', 'FREIGHT_FEE') and v_category_id is null then
    v_effective := 'UNRESOLVED';
  end if;
  -- Inventory purchases are recorded through the item writers
  -- (record_ai_suggested_candidate / record_ai_item_proposal); reaching
  -- this writer with INVENTORY_PURCHASE means "needs a manual choice".
  if v_effective = 'INVENTORY_PURCHASE' then
    v_effective := 'UNRESOLVED';
  end if;
  v_subtype := case when v_effective = 'CREDIT_RETURN' then p_proposed_credit_subtype else null end;
  v_scope := case when v_effective = 'DISCOUNT' then p_discount_scope else null end;

  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key,
    line_treatment, credit_subtype, discount_scope, spend_category_id,
    ai_proposed_treatment, ai_proposed_credit_subtype, ai_proposed_spend_category_id,
    ai_confidence, ai_reason, ai_evidence, ai_review_fields, treatment_rule_id,
    resolution_source, status, resolved_against_snapshot, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key,
    v_effective, v_subtype, v_scope,
    case when v_effective in ('EXPENSE', 'FREIGHT_FEE') then v_category_id else null end,
    p_proposed_treatment, p_proposed_credit_subtype, v_category_id,
    p_ai_confidence, p_ai_reason, p_ai_evidence, p_ai_review_fields, p_treatment_rule_id,
    p_resolution_source, 'PENDING_REVIEW',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    line_treatment = excluded.line_treatment,
    credit_subtype = excluded.credit_subtype,
    discount_scope = excluded.discount_scope,
    discount_related_line_key = null,
    spend_category_id = excluded.spend_category_id,
    explanation = null,
    inventory_item_id = null,
    ai_suggested_inventory_item_id = null,
    vendor_item_purchase_unit_id = null,
    return_quantity = null,
    return_unit_code = null,
    return_location_id = null,
    return_reason = null,
    return_impact_acknowledged = false,
    ai_proposed_treatment = excluded.ai_proposed_treatment,
    ai_proposed_credit_subtype = excluded.ai_proposed_credit_subtype,
    ai_proposed_spend_category_id = excluded.ai_proposed_spend_category_id,
    ai_confidence = excluded.ai_confidence,
    ai_reason = excluded.ai_reason,
    ai_evidence = excluded.ai_evidence,
    ai_review_fields = excluded.ai_review_fields,
    treatment_rule_id = excluded.treatment_rule_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = null,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  return query select v_classification_id, v_effective;
end;
$$;

revoke all on function public.record_ai_line_treatment(uuid, uuid, uuid, text, text, uuid, numeric, text, jsonb, jsonb, text, uuid, text) from public;
grant execute on function public.record_ai_line_treatment(uuid, uuid, uuid, text, text, uuid, numeric, text, jsonb, jsonb, text, uuid, text) to service_role;

-- ============================================================
-- 6. set_purchase_document_line_treatment -- the MANAGER decision for a
--    line's treatment. Validates every treatment-specific requirement
--    server-side (the client's choice is never trusted), clears fields
--    that no longer apply, confirms non-item treatments immediately, and
--    re-opens item matching when a line becomes an inventory purchase.
--    Optionally remembers an organization-scoped, vendor-specific rule
--    (never silently: p_remember_vendor_rule is the manager's explicit
--    choice, and the rule is audited).
-- ============================================================
create or replace function public.set_purchase_document_line_treatment(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_line_treatment text,
  p_credit_subtype text default null,
  p_spend_category_id uuid default null,
  p_explanation text default null,
  p_discount_scope text default null,
  p_discount_related_line_key uuid default null,
  p_return_inventory_item_id uuid default null,
  p_return_quantity numeric default null,
  p_return_unit_code text default null,
  p_return_location_id uuid default null,
  p_return_reason text default null,
  p_return_impact_acknowledged boolean default false,
  p_remember_vendor_rule boolean default false
)
returns table (out_classification_id uuid, out_status text, out_rule_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_line record;
  v_existing record;
  v_category record;
  v_item record;
  v_unit_id uuid;
  v_unit_code text;
  v_factor numeric;
  v_base_quantity numeric;
  v_balance numeric;
  v_status text;
  v_inventory_item_id uuid;
  v_spend_category_id uuid;
  v_explanation text := nullif(btrim(coalesce(p_explanation, '')), '');
  v_return_reason text := nullif(btrim(coalesce(p_return_reason, '')), '');
  v_return_unit_code text := nullif(upper(btrim(coalesce(p_return_unit_code, ''))), '');
  v_subtype text;
  v_scope text;
  v_related uuid;
  v_classification_id uuid;
  v_rule_id uuid;
  v_normalized_description text;
  v_before jsonb;
  v_after jsonb;
begin
  if p_line_treatment not in ('INVENTORY_PURCHASE', 'EXPENSE', 'CREDIT_RETURN', 'DISCOUNT', 'TAX', 'FREIGHT_FEE', 'UNRESOLVED') then
    raise exception 'unknown line treatment %', p_line_treatment using errcode = 'GA033';
  end if;

  select status, created_by_app_user_id, vendor_id into v_doc
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;
  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;
  if v_doc.status <> 'DRAFT' then
    raise exception 'purchase_document % is % -- line treatments can only be changed on a DRAFT', p_purchase_document_id, v_doc.status
      using errcode = 'GA003';
  end if;
  if v_doc.created_by_app_user_id is distinct from p_app_user_id
     and not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.correct_any_draft') then
    raise exception 'app_user % is not the preparer of purchase_document % and may not classify its lines', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  select vendor_sku, description, package_unit, measured_unit, line_total
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;
  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  select * into v_existing
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  v_before := case when v_existing.id is null then null else jsonb_build_object(
    'lineTreatment', v_existing.line_treatment, 'creditSubtype', v_existing.credit_subtype, 'spendCategoryId', v_existing.spend_category_id,
    'inventoryItemId', v_existing.inventory_item_id, 'status', v_existing.status, 'discountScope', v_existing.discount_scope,
    'returnQuantity', v_existing.return_quantity, 'returnUnitCode', v_existing.return_unit_code, 'returnLocationId', v_existing.return_location_id) end;

  -- ---- treatment-specific validation --------------------------------
  if p_line_treatment in ('EXPENSE', 'FREIGHT_FEE') then
    if p_spend_category_id is null then
      raise exception 'an expense category is required for a % line', p_line_treatment using errcode = 'GA087';
    end if;
    select id, is_active, requires_explanation into v_category
      from public.spend_categories
     where id = p_spend_category_id and organization_id = p_organization_id;
    if not found then
      raise exception 'expense category % not found in organization %', p_spend_category_id, p_organization_id using errcode = 'GA034';
    end if;
    if not v_category.is_active then
      raise exception 'expense category % is not active', p_spend_category_id using errcode = 'GA087';
    end if;
    if v_category.requires_explanation and v_explanation is null then
      raise exception 'a written explanation is required for this expense category' using errcode = 'GA086';
    end if;
    v_spend_category_id := p_spend_category_id;
    v_status := 'CONFIRMED';
  elsif p_line_treatment = 'TAX' then
    v_status := 'CONFIRMED';
  elsif p_line_treatment = 'DISCOUNT' then
    if p_discount_scope is null or p_discount_scope not in ('LINE', 'DOCUMENT') then
      raise exception 'a discount needs a scope of LINE or DOCUMENT' using errcode = 'GA087';
    end if;
    v_scope := p_discount_scope;
    if p_discount_related_line_key is not null then
      if not exists (
        select 1 from public.purchase_document_lines
         where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id and line_key = p_discount_related_line_key
      ) then
        raise exception 'related line % not found on the current revision of purchase_document %', p_discount_related_line_key, p_purchase_document_id
          using errcode = 'GA011';
      end if;
      v_related := p_discount_related_line_key;
    end if;
    v_status := 'CONFIRMED';
  elsif p_line_treatment = 'CREDIT_RETURN' then
    if p_credit_subtype is null or p_credit_subtype not in ('FINANCIAL_CREDIT', 'RETURNABLE_CONTAINER_CREDIT', 'INVENTORY_RETURN') then
      raise exception 'a credit / return line needs a subtype: did tracked inventory physically leave the store?' using errcode = 'GA087';
    end if;
    v_subtype := p_credit_subtype;
    v_status := 'CONFIRMED';
    if p_credit_subtype = 'INVENTORY_RETURN' then
      if p_return_inventory_item_id is null then
        raise exception 'an inventory return needs the canonical item that was returned' using errcode = 'GA087';
      end if;
      select id, base_unit_id, disposition, approval_status into v_item
        from public.inventory_items
       where id = p_return_inventory_item_id and organization_id = p_organization_id;
      if not found then
        raise exception 'inventory_item % not found in organization %', p_return_inventory_item_id, p_organization_id using errcode = 'GA034';
      end if;
      if v_item.approval_status <> 'CONFIRMED' or v_item.disposition <> 'INVENTORY' then
        raise exception 'inventory_item % is not a confirmed, tracked inventory item', p_return_inventory_item_id using errcode = 'GA009';
      end if;
      if p_return_quantity is null or p_return_quantity <= 0 then
        raise exception 'an inventory return needs a positive returned quantity' using errcode = 'GA087';
      end if;
      if v_return_unit_code is null then
        raise exception 'an inventory return needs the returned unit' using errcode = 'GA087';
      end if;
      select u.id, u.code into v_unit_id, v_unit_code from public.units u where upper(btrim(u.code)) = v_return_unit_code;
      if not found then
        raise exception 'unit "%" is not a recognized unit', v_return_unit_code using errcode = 'GA087';
      end if;
      if v_unit_id = v_item.base_unit_id then
        v_factor := 1;
      else
        select iiu.conversion_factor into v_factor
          from public.inventory_item_units iiu
         where iiu.inventory_item_id = v_item.id and iiu.unit_id = v_unit_id and iiu.is_active
           and iiu.conversion_factor is not null and not iiu.requires_actual_measurement;
        if not found or v_factor is null then
          raise exception 'unit "%" is not a fixed-conversion unit configured for this item -- enter the return in its base unit', v_return_unit_code
            using errcode = 'GA087';
        end if;
      end if;
      v_base_quantity := p_return_quantity * v_factor;
      if p_return_location_id is null then
        raise exception 'an inventory return needs the source location the stock left from' using errcode = 'GA087';
      end if;
      if not exists (
        select 1 from public.locations l
         where l.id = p_return_location_id and l.organization_id = p_organization_id and l.is_active and l.is_storage_eligible
      ) then
        raise exception 'location % is not an active, storage-eligible location in organization %', p_return_location_id, p_organization_id
          using errcode = 'GA021';
      end if;
      if v_return_reason is null then
        raise exception 'an inventory return needs a reason' using errcode = 'GA087';
      end if;
      if not coalesce(p_return_impact_acknowledged, false) then
        raise exception 'the inventory impact of this return must be acknowledged' using errcode = 'GA087';
      end if;
      v_balance := public.inventory_location_item_balance(p_organization_id, v_item.id, p_return_location_id);
      if v_base_quantity > v_balance then
        raise exception 'returning % would take inventory_item % below zero at location % (on hand %)',
          v_base_quantity, v_item.id, p_return_location_id, v_balance
          using errcode = 'GA022',
                detail = jsonb_build_object('availableQuantity', v_balance, 'requestedQuantity', v_base_quantity, 'unitCode', v_unit_code)::text;
      end if;
      v_inventory_item_id := v_item.id;
    end if;
  elsif p_line_treatment = 'INVENTORY_PURCHASE' then
    -- Re-opens item matching unless the line is ALREADY a confirmed
    -- inventory purchase (a re-select is a no-op, never a reset).
    if v_existing.id is not null and v_existing.line_treatment = 'INVENTORY_PURCHASE' and v_existing.status = 'CONFIRMED' and v_existing.inventory_item_id is not null then
      return query select v_existing.id, v_existing.status, null::uuid;
      return;
    end if;
    v_status := 'PENDING_REVIEW';
  else
    v_status := 'PENDING_REVIEW';
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key,
    line_treatment, credit_subtype, discount_scope, discount_related_line_key,
    spend_category_id, explanation, inventory_item_id,
    return_quantity, return_unit_code, return_location_id, return_reason, return_impact_acknowledged,
    resolution_source, status, resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key,
    p_line_treatment, v_subtype, v_scope, v_related,
    v_spend_category_id, case when p_line_treatment in ('EXPENSE', 'FREIGHT_FEE') then v_explanation else null end, v_inventory_item_id,
    case when v_subtype = 'INVENTORY_RETURN' then p_return_quantity end,
    case when v_subtype = 'INVENTORY_RETURN' then v_unit_code end,
    case when v_subtype = 'INVENTORY_RETURN' then p_return_location_id end,
    case when v_subtype = 'INVENTORY_RETURN' then v_return_reason end,
    case when v_subtype = 'INVENTORY_RETURN' then true else false end,
    'MANUAL', v_status,
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    case when v_status = 'CONFIRMED' then p_app_user_id else null end,
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    line_treatment = excluded.line_treatment,
    credit_subtype = excluded.credit_subtype,
    discount_scope = excluded.discount_scope,
    discount_related_line_key = excluded.discount_related_line_key,
    spend_category_id = excluded.spend_category_id,
    explanation = excluded.explanation,
    -- an inventory purchase re-opens matching: the previous item link (if
    -- it was ever a different treatment) is cleared; an AI item candidate
    -- is kept only when it is still an inventory item
    inventory_item_id = excluded.inventory_item_id,
    ai_suggested_inventory_item_id = case
      when excluded.line_treatment = 'INVENTORY_PURCHASE' then purchase_document_line_classifications.ai_suggested_inventory_item_id
      else null end,
    vendor_item_purchase_unit_id = case
      when excluded.line_treatment = 'INVENTORY_PURCHASE' then purchase_document_line_classifications.vendor_item_purchase_unit_id
      else null end,
    return_quantity = excluded.return_quantity,
    return_unit_code = excluded.return_unit_code,
    return_location_id = excluded.return_location_id,
    return_reason = excluded.return_reason,
    return_impact_acknowledged = excluded.return_impact_acknowledged,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  -- Optional, explicit, audited vendor-specific learning for NON-item
  -- treatments (inventory items already learn through vendor_item_mappings).
  if coalesce(p_remember_vendor_rule, false) and v_status = 'CONFIRMED' and v_doc.vendor_id is not null
     and p_line_treatment in ('EXPENSE', 'FREIGHT_FEE', 'TAX', 'DISCOUNT', 'CREDIT_RETURN') then
    v_normalized_description := public.normalize_line_description(v_line.description);
    if nullif(btrim(coalesce(v_line.vendor_sku, '')), '') is not null or v_normalized_description is not null then
      update public.vendor_line_treatment_rules r
         set is_active = false, deactivated_by_app_user_id = p_app_user_id, deactivated_at = now()
       where r.organization_id = p_organization_id
         and r.vendor_id = v_doc.vendor_id
         and r.is_active
         and (
           (nullif(btrim(coalesce(v_line.vendor_sku, '')), '') is not null and r.vendor_sku = btrim(v_line.vendor_sku))
           or (nullif(btrim(coalesce(v_line.vendor_sku, '')), '') is null and r.vendor_sku is null and r.normalized_description = v_normalized_description)
         );
      insert into public.vendor_line_treatment_rules (
        organization_id, vendor_id, vendor_sku, normalized_description, line_treatment, credit_subtype, spend_category_id, discount_scope,
        created_by_app_user_id, source_purchase_document_id, source_line_key
      ) values (
        p_organization_id, v_doc.vendor_id, nullif(btrim(coalesce(v_line.vendor_sku, '')), ''), v_normalized_description,
        p_line_treatment, v_subtype, v_spend_category_id, v_scope,
        p_app_user_id, p_purchase_document_id, p_line_key
      ) returning id into v_rule_id;
      insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
      values (p_organization_id, p_app_user_id, 'VENDOR_LINE_TREATMENT_RULE_CREATED', 'vendor_line_treatment_rule', v_rule_id,
              jsonb_build_object('vendorId', v_doc.vendor_id, 'vendorSku', nullif(btrim(coalesce(v_line.vendor_sku, '')), ''),
                                 'normalizedDescription', v_normalized_description, 'lineTreatment', p_line_treatment,
                                 'creditSubtype', v_subtype, 'spendCategoryId', v_spend_category_id, 'discountScope', v_scope,
                                 'sourcePurchaseDocumentId', p_purchase_document_id, 'sourceLineKey', p_line_key));
      update public.purchase_document_line_classifications set treatment_rule_id = v_rule_id where id = v_classification_id;
    end if;
  end if;

  v_after := jsonb_build_object(
    'lineTreatment', p_line_treatment, 'creditSubtype', v_subtype, 'spendCategoryId', v_spend_category_id, 'explanation', v_explanation,
    'inventoryItemId', v_inventory_item_id, 'status', v_status, 'discountScope', v_scope, 'relatedLineKey', v_related,
    'returnQuantity', case when v_subtype = 'INVENTORY_RETURN' then p_return_quantity end,
    'returnUnitCode', case when v_subtype = 'INVENTORY_RETURN' then v_unit_code end,
    'returnBaseQuantity', v_base_quantity,
    'returnLocationId', case when v_subtype = 'INVENTORY_RETURN' then p_return_location_id end,
    'returnReason', case when v_subtype = 'INVENTORY_RETURN' then v_return_reason end,
    'rememberedRuleId', v_rule_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_TREATMENT_SET', 'purchase_document', p_purchase_document_id,
          v_before, v_after || jsonb_build_object('lineKey', p_line_key, 'classificationId', v_classification_id));

  return query select v_classification_id, v_status, v_rule_id;
end;
$$;

revoke all on function public.set_purchase_document_line_treatment(uuid, uuid, uuid, uuid, text, text, uuid, text, text, uuid, uuid, numeric, text, uuid, text, boolean, boolean) from public;
grant execute on function public.set_purchase_document_line_treatment(uuid, uuid, uuid, uuid, text, text, uuid, text, text, uuid, uuid, numeric, text, uuid, text, boolean, boolean) to service_role;

-- ============================================================
-- 7. accept_ai_assigned_line_classifications -- the manager's acceptance
--    of every high-confidence ("AI assigned" / "Matched previous
--    decision") proposal on a DRAFT, recorded as their own decision
--    (resolved_by = the manager, resolution_source = AI_ACCEPTED, one
--    audit event per line). Called when the manager progresses past
--    Review Invoice with those labels visible, and again -- idempotently,
--    inside the same transaction -- by sole-approver posting, so every
--    gate sees the same accepted state. Returns how many were accepted.
-- ============================================================
create or replace function public.accept_ai_assigned_line_classifications(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_app_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc record;
  v_row record;
  v_line record;
  v_count integer := 0;
begin
  select status, created_by_app_user_id into v_doc
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;
  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;
  if v_doc.status <> 'DRAFT' then
    return 0;
  end if;
  if v_doc.created_by_app_user_id is distinct from p_app_user_id
     and not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.correct_any_draft') then
    raise exception 'app_user % is not the preparer of purchase_document % and may not accept its classifications', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  for v_row in
    select c.id, c.line_key, c.line_treatment, c.credit_subtype, c.spend_category_id, c.ai_suggested_inventory_item_id, c.ai_confidence, c.resolution_source
      from public.purchase_document_line_classifications c
     where c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and public.line_classification_is_auto_acceptable(c.id)
     order by c.line_number_snapshot nulls last, c.created_at
  loop
    select vendor_sku, description, package_unit, measured_unit into v_line
      from public.purchase_document_lines
     where purchase_document_id = p_purchase_document_id and line_key = v_row.line_key and organization_id = p_organization_id;
    if not found then
      continue;
    end if;

    update public.purchase_document_line_classifications
       set status = 'CONFIRMED',
           resolution_source = 'AI_ACCEPTED',
           inventory_item_id = case when line_treatment = 'INVENTORY_PURCHASE' then ai_suggested_inventory_item_id else inventory_item_id end,
           resolved_by_app_user_id = p_app_user_id,
           resolved_at = now(),
           resolved_against_snapshot = jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit)
     where id = v_row.id;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_AI_ACCEPTED', 'purchase_document', p_purchase_document_id,
            jsonb_build_object('lineKey', v_row.line_key, 'classificationId', v_row.id, 'lineTreatment', v_row.line_treatment,
                               'creditSubtype', v_row.credit_subtype, 'spendCategoryId', v_row.spend_category_id,
                               'inventoryItemId', case when v_row.line_treatment = 'INVENTORY_PURCHASE' then v_row.ai_suggested_inventory_item_id end,
                               'aiConfidence', v_row.ai_confidence, 'proposedBy', v_row.resolution_source));
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.accept_ai_assigned_line_classifications(uuid, uuid, uuid) from public;
grant execute on function public.accept_ai_assigned_line_classifications(uuid, uuid, uuid) to service_role;

-- ============================================================
-- 8. Completeness gate (20260811100047) -- now also refuses an UNRESOLVED
--    line and any treatment whose required fields are invalid. Body
--    reproduced with the two extra predicates only.
-- ============================================================
create or replace function public.purchase_document_preparation_incomplete(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.purchase_document_lines pdl
    left join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
    where pdl.purchase_document_id = p_purchase_document_id
      and pdl.organization_id = p_organization_id
      and (
        c.id is null
        or c.status in ('PENDING_REVIEW', 'STALE')
        or c.line_treatment = 'UNRESOLVED'
        or public.line_classification_treatment_issue(c.id) is not null
        or (
          c.status = 'CONFIRMED'
          and c.disposition = 'INVENTORY'
          and not exists (
            select 1
            from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
            join public.receipt_lines rl on rl.receipt_id = er.id
            where rl.matched_line_key = pdl.line_key
              and rl.actual_received_package_quantity is not null
              and rl.location_id is not null
              and (
                rl.actual_verified_base_quantity is not null
                or not exists (
                  select 1
                  from public.inventory_item_units iiu
                  where iiu.inventory_item_id = c.inventory_item_id
                    and iiu.unit_id <> (select ii.base_unit_id from public.inventory_items ii where ii.id = c.inventory_item_id)
                    and iiu.requires_actual_measurement
                )
              )
          )
        )
      )
  );
$$;

-- ============================================================
-- 9. Posting-blocker read model (20260811100154) -- the receipt-based
--    scan (byte-identical, still in lockstep with the enforcement scan)
--    UNIONed with the treatment scan, so Items & Receiving shows exactly
--    what posting will refuse. A high-confidence, still-pending proposal
--    is NOT a blocker here (it is accepted by posting itself).
-- ============================================================
create or replace function public.get_purchase_document_posting_blockers(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns table (
  out_line_key uuid,
  out_description text,
  out_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.line_key, b.description, b.reason
  from (
    select rl.matched_line_key as line_key,
           coalesce(rl.description_snapshot, 'Line') as description,
           case
             when c.inventory_item_id is null then 'canonical inventory item is not resolved'
             when rl.actual_received_package_quantity is null then 'received quantity has not been recorded'
             when rl.location_id is null then 'storage location is missing'
             when rl.actual_received_package_unit is null then 'received unit is missing'
             when u.id is null then 'received unit "' || rl.actual_received_package_unit || '" is not a recognized unit'
             when coalesce(vpu.purchase_unit_id, ii.base_unit_id) is null then 'this vendor/SKU has no confirmed purchase package for this item -- resolve it before posting'
             when u.id <> coalesce(vpu.purchase_unit_id, ii.base_unit_id) then 'received unit "' || rl.actual_received_package_unit || '" does not match the confirmed purchase package for this vendor/SKU'
             when coalesce(vpu.requires_actual_measurement, false) and rl.actual_verified_base_quantity is null
               then 'verified measurement is required -- this item varies by delivery'
             when not coalesce(vpu.requires_actual_measurement, false) and rl.actual_verified_base_quantity is not null
                  and rl.actual_verified_base_quantity <> rl.actual_received_package_quantity * coalesce(vpu.conversion_factor, 1)
               then 'stored verified quantity is inconsistent with this vendor/SKU''s confirmed conversion -- review before posting'
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
      left join public.vendor_item_purchase_units vpu
        on vpu.id = c.vendor_item_purchase_unit_id and vpu.organization_id = p_organization_id
      left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
     where rl.matched_line_key is not null
       and pl.id is null
       and (rl.actual_received_package_quantity is null or rl.actual_received_package_quantity > 0)
    union all
    select pdl.line_key,
           coalesce(pdl.description, 'Line'),
           case
             when c.id is null then 'line has not been classified'
             when c.line_treatment = 'UNRESOLVED' then 'line has not been classified'
             when c.status in ('PENDING_REVIEW', 'STALE') and not public.line_classification_is_auto_acceptable(c.id)
               then 'classification is awaiting the manager''s confirmation'
             else public.line_classification_treatment_issue(c.id)
           end
      from public.purchase_document_lines pdl
      left join public.purchase_document_line_classifications c
        on c.organization_id = pdl.organization_id
       and c.purchase_document_id = pdl.purchase_document_id
       and c.line_key = pdl.line_key
     where pdl.purchase_document_id = p_purchase_document_id
       and pdl.organization_id = p_organization_id
  ) b
  where b.reason is not null;
$$;

-- ============================================================
-- 10. Expense-category usage counts (20260811100181): expense lines no
--     longer create inventory_items rows, so usage is what it always
--     meant -- CONFIRMED line classifications referencing the category.
-- ============================================================
create or replace function public.get_spend_category_usage_counts(
  p_organization_id uuid
)
returns table (
  out_category_id uuid,
  out_usage_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select spend_category_id, count(*)
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and status = 'CONFIRMED'
     and spend_category_id is not null
   group by spend_category_id;
$$;

-- ============================================================
-- 11. Vendor rule administration (Admin-only in the action layer).
-- ============================================================
create or replace function public.list_vendor_line_treatment_rules(
  p_organization_id uuid
)
returns table (
  out_id uuid,
  out_vendor_id uuid,
  out_vendor_name text,
  out_vendor_sku text,
  out_normalized_description text,
  out_line_treatment text,
  out_credit_subtype text,
  out_spend_category_id uuid,
  out_spend_category_name text,
  out_spend_category_is_active boolean,
  out_discount_scope text,
  out_is_active boolean,
  out_created_by_name text,
  out_created_at timestamptz,
  out_source_purchase_document_id uuid,
  out_match_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.vendor_id, v.name, r.vendor_sku, r.normalized_description, r.line_treatment, r.credit_subtype,
         r.spend_category_id, sc.name, sc.is_active, r.discount_scope, r.is_active,
         (e.first_name || ' ' || e.last_name), r.created_at, r.source_purchase_document_id,
         (select count(*) from public.purchase_document_line_classifications c where c.treatment_rule_id = r.id)
    from public.vendor_line_treatment_rules r
    join public.vendors v on v.id = r.vendor_id and v.organization_id = r.organization_id
    left join public.spend_categories sc on sc.id = r.spend_category_id and sc.organization_id = r.organization_id
    left join public.app_users au on au.id = r.created_by_app_user_id
    left join public.employees e on e.id = au.employee_id
   where r.organization_id = p_organization_id
   order by r.is_active desc, v.name, r.vendor_sku nulls last, r.normalized_description;
$$;

revoke all on function public.list_vendor_line_treatment_rules(uuid) from public;
grant execute on function public.list_vendor_line_treatment_rules(uuid) to service_role;

create or replace function public.set_vendor_line_treatment_rule_active(
  p_organization_id uuid,
  p_actor_app_user_id uuid,
  p_rule_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule record;
begin
  select * into v_rule from public.vendor_line_treatment_rules where id = p_rule_id and organization_id = p_organization_id;
  if not found then
    raise exception 'vendor line treatment rule % not found in organization %', p_rule_id, p_organization_id using errcode = 'GA034';
  end if;
  if v_rule.is_active = p_is_active then
    return;
  end if;
  if p_is_active and exists (
    select 1 from public.vendor_line_treatment_rules r
     where r.organization_id = p_organization_id and r.vendor_id = v_rule.vendor_id and r.is_active and r.id <> v_rule.id
       and ((v_rule.vendor_sku is not null and r.vendor_sku = v_rule.vendor_sku)
         or (v_rule.vendor_sku is null and r.vendor_sku is null and r.normalized_description = v_rule.normalized_description))
  ) then
    raise exception 'another active rule already covers this vendor SKU/description' using errcode = 'GA087';
  end if;
  update public.vendor_line_treatment_rules
     set is_active = p_is_active,
         deactivated_by_app_user_id = case when p_is_active then null else p_actor_app_user_id end,
         deactivated_at = case when p_is_active then null else now() end
   where id = p_rule_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_actor_app_user_id,
          case when p_is_active then 'VENDOR_LINE_TREATMENT_RULE_ACTIVATED' else 'VENDOR_LINE_TREATMENT_RULE_DEACTIVATED' end,
          'vendor_line_treatment_rule', p_rule_id,
          jsonb_build_object('isActive', v_rule.is_active), jsonb_build_object('isActive', p_is_active));
end;
$$;

revoke all on function public.set_vendor_line_treatment_rule_active(uuid, uuid, uuid, boolean) from public;
grant execute on function public.set_vendor_line_treatment_rule_active(uuid, uuid, uuid, boolean) to service_role;

-- Rule lookup for the classifier: the active rule for this vendor + SKU
-- (preferred) or normalized description, IGNORING any rule whose expense
-- category has been deactivated (an Admin disabling a category
-- invalidates every rule that depends on it).
create or replace function public.find_vendor_line_treatment_rule(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_vendor_sku text,
  p_description text
)
returns table (
  out_rule_id uuid,
  out_line_treatment text,
  out_credit_subtype text,
  out_spend_category_id uuid,
  out_discount_scope text,
  out_match_basis text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.line_treatment, r.credit_subtype, r.spend_category_id, r.discount_scope,
         case when r.vendor_sku is not null then 'VENDOR_SKU' else 'NORMALIZED_DESCRIPTION' end
    from public.vendor_line_treatment_rules r
    left join public.spend_categories sc on sc.id = r.spend_category_id and sc.organization_id = r.organization_id
   where r.organization_id = p_organization_id
     and r.vendor_id = p_vendor_id
     and r.is_active
     and (r.spend_category_id is null or coalesce(sc.is_active, false))
     and (
       (nullif(btrim(coalesce(p_vendor_sku, '')), '') is not null and r.vendor_sku = btrim(p_vendor_sku))
       or (r.vendor_sku is null and r.normalized_description = public.normalize_line_description(p_description))
     )
   order by (r.vendor_sku is not null) desc, r.created_at desc
   limit 1;
$$;

revoke all on function public.find_vendor_line_treatment_rule(uuid, uuid, text, text) from public;
grant execute on function public.find_vendor_line_treatment_rule(uuid, uuid, text, text) to service_role;


-- ============================================================
-- 12. post_purchase_document_inventory -- reproduced from 20260811100175
--     with three additions, each marked "LINE-TREATMENT":
--       (a) defense in depth: any current line that is not CONFIRMED, is
--           UNRESOLVED, or has an invalid treatment refuses the whole post
--           (GA088) -- an unresolved line can never post, even by a
--           direct RPC call against a VERIFIED document;
--       (b) INVENTORY_RETURN credit lines post as audited VENDOR_RETURN
--           movements (one per source location) in the SAME transaction,
--           with a serialized negative-stock check (GA022) that rolls the
--           entire posting back on failure -- never a partial post;
--       (c) a document with no inventory changes at all (expense-only,
--           credits/tax/discounts only) returns NO_INVENTORY_CHANGES
--           instead of raising -- posting such an invoice records its
--           approved classifications and creates no receipt, movement,
--           balance, kiosk unit, price-history or posting row.
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
  v_revision_group_id uuid;
  v_sibling_already_posted boolean;
  v_blockers jsonb;
  v_candidate record;
  v_location record;
  v_posting_id uuid;
  v_movement_id uuid;
  v_movement_line_id uuid;
  v_movement_count integer := 0;
  v_posted_count integer := 0;
  v_unposted_candidate_count integer;
  v_already_posted_count integer;
  v_unposted_return_count integer;
  v_already_posted_return_count integer;
  v_return record;
  v_return_base_quantity numeric;
  v_balance numeric;
  v_affected record;
  v_new_balance numeric;
begin
  select status, revision_group_id into v_doc_status, v_revision_group_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_doc_status is null then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_doc_status <> 'VERIFIED' then
    raise exception 'purchase_document % is % and cannot be posted to inventory -- only a VERIFIED document can post', p_purchase_document_id, v_doc_status
      using errcode = 'GA003';
  end if;

  -- LINE-TREATMENT (a): every current line must be a CONFIRMED, valid
  -- treatment. UNRESOLVED is never a valid posting classification.
  select jsonb_agg(jsonb_build_object('lineKey', t.line_key, 'description', t.description, 'reason', t.reason))
    into v_blockers
    from (
      select pdl.line_key, coalesce(pdl.description, 'Line') as description,
             case
               when c.id is null then 'line has not been classified'
               when c.line_treatment = 'UNRESOLVED' then 'line has not been classified'
               when c.status <> 'CONFIRMED' then 'classification is not confirmed'
               else public.line_classification_treatment_issue(c.id)
             end as reason
        from public.purchase_document_lines pdl
        left join public.purchase_document_line_classifications c
          on c.organization_id = pdl.organization_id
         and c.purchase_document_id = pdl.purchase_document_id
         and c.line_key = pdl.line_key
       where pdl.purchase_document_id = p_purchase_document_id
         and pdl.organization_id = p_organization_id
    ) t
   where t.reason is not null;

  if v_blockers is not null then
    raise exception 'cannot post -- % line(s) have no valid classification', jsonb_array_length(v_blockers)
      using errcode = 'GA088', detail = v_blockers::text;
  end if;

  -- An amendment lineage may post inventory at most once -- never on more
  -- than one of its own revisions (see this migration's header comment).
  select exists (
    select 1
      from public.purchase_document_inventory_postings pip
      join public.purchase_documents sibling
        on sibling.id = pip.purchase_document_id and sibling.organization_id = p_organization_id
     where pip.organization_id = p_organization_id
       and sibling.revision_group_id = v_revision_group_id
       and sibling.id <> p_purchase_document_id
  ) into v_sibling_already_posted;

  if v_sibling_already_posted then
    raise exception 'purchase_document % cannot post -- another revision in this amendment lineage has already posted inventory for this business document', p_purchase_document_id
      using errcode = 'GA075';
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
             when coalesce(vpu.purchase_unit_id, ii.base_unit_id) is null then 'this vendor/SKU has no confirmed purchase package for this item -- resolve it before posting'
             when u.id <> coalesce(vpu.purchase_unit_id, ii.base_unit_id) then 'received unit "' || rl.actual_received_package_unit || '" does not match the confirmed purchase package for this vendor/SKU'
             when coalesce(vpu.requires_actual_measurement, false) and rl.actual_verified_base_quantity is null
               then 'verified measurement is required -- this item varies by delivery'
             when not coalesce(vpu.requires_actual_measurement, false) and rl.actual_verified_base_quantity is not null
                  and rl.actual_verified_base_quantity <> rl.actual_received_package_quantity * coalesce(vpu.conversion_factor, 1)
               then 'stored verified quantity is inconsistent with this vendor/SKU''s confirmed conversion -- review before posting'
             else null
           end as reason
      from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
      join public.receipt_lines rl on rl.receipt_id = er.id and rl.receipt_id in (select out_receipt_id from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id))
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
      left join public.vendor_item_purchase_units vpu
        on vpu.id = c.vendor_item_purchase_unit_id and vpu.organization_id = p_organization_id
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

  -- ONE statement, ONE snapshot: unposted candidates and already-posted
  -- lines counted together, so a concurrent winner committing between
  -- reads can never skew the branch decision.
  select
    count(*) filter (
      where pl.id is null
        and c.status = 'CONFIRMED'
        and c.disposition = 'INVENTORY'
        and rl.actual_received_package_quantity > 0
    ),
    count(*) filter (where pl.id is not null)
    into v_unposted_candidate_count, v_already_posted_count
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id and rl.receipt_id in (select out_receipt_id from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id))
    left join public.purchase_document_line_classifications c
      on c.organization_id = p_organization_id
     and c.purchase_document_id = p_purchase_document_id
     and c.line_key = rl.matched_line_key
    left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
   where rl.matched_line_key is not null;

  -- LINE-TREATMENT (b): inventory returns awaiting posting, same snapshot
  -- discipline.
  select
    count(*) filter (where rtl.id is null),
    count(*) filter (where rtl.id is not null)
    into v_unposted_return_count, v_already_posted_return_count
    from public.purchase_document_line_classifications c
    left join public.purchase_document_inventory_return_lines rtl on rtl.classification_id = c.id
   where c.organization_id = p_organization_id
     and c.purchase_document_id = p_purchase_document_id
     and c.status = 'CONFIRMED'
     and c.line_treatment = 'CREDIT_RETURN'
     and c.credit_subtype = 'INVENTORY_RETURN';

  if v_unposted_candidate_count = 0 and v_unposted_return_count = 0 then
    if v_already_posted_count > 0 or v_already_posted_return_count > 0 then
      select id into v_posting_id
        from public.purchase_document_inventory_postings
       where organization_id = p_organization_id and purchase_document_id = p_purchase_document_id
       order by posted_at desc limit 1;
      return query select 'ALREADY_POSTED'::text, v_posting_id, 0, 0;
      return;
    end if;
    -- LINE-TREATMENT (c): nothing touches inventory on this document.
    return query select 'NO_INVENTORY_CHANGES'::text, null::uuid, 0, 0;
    return;
  end if;

  -- All checks passed -- post atomically. The unique receipt_line_id /
  -- classification_id backstops make two concurrent posts converge: the
  -- loser's entire posting work rolls back (this EXCEPTION block is a
  -- subtransaction) and it reports the winner's posting instead.
  begin
    insert into public.purchase_document_inventory_postings (organization_id, purchase_document_id, posted_by_app_user_id)
    values (p_organization_id, p_purchase_document_id, p_app_user_id)
    returning id into v_posting_id;

    -- One movement per distinct storage location in this posting.
    for v_location in
      select distinct rl.location_id, loc.timezone
        from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
        join public.receipt_lines rl on rl.receipt_id = er.id and rl.receipt_id in (select out_receipt_id from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id))
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
               coalesce(vpu.purchase_unit_id, ii.base_unit_id) as entered_unit_id,
               coalesce(vpu.requires_actual_measurement, false) as requires_actual_measurement,
               case
                 when coalesce(vpu.requires_actual_measurement, false) then rl.actual_verified_base_quantity
                 else rl.actual_received_package_quantity * coalesce(vpu.conversion_factor, 1)
               end as resolved_base_quantity
          from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
          join public.receipt_lines rl on rl.receipt_id = er.id and rl.receipt_id in (select out_receipt_id from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id))
          join public.purchase_document_line_classifications c
            on c.organization_id = p_organization_id
           and c.purchase_document_id = p_purchase_document_id
           and c.line_key = rl.matched_line_key
           and c.status = 'CONFIRMED'
           and c.disposition = 'INVENTORY'
          join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
          join public.units u on upper(btrim(u.code)) = upper(btrim(rl.actual_received_package_unit))
          left join public.vendor_item_purchase_units vpu
            on vpu.id = c.vendor_item_purchase_unit_id and vpu.organization_id = p_organization_id
          left join public.purchase_document_inventory_posting_lines pl on pl.receipt_line_id = rl.id
         where rl.matched_line_key is not null
           and pl.id is null
           and rl.actual_received_package_quantity > 0
           and rl.location_id = v_location.location_id
           and u.id = coalesce(vpu.purchase_unit_id, ii.base_unit_id)
      loop
        insert into public.inventory_movement_lines (
          movement_id, inventory_item_id, entered_quantity, entered_unit_id, measured_base_quantity
        ) values (
          v_movement_id, v_candidate.inventory_item_id, v_candidate.entered_quantity, v_candidate.entered_unit_id,
          v_candidate.resolved_base_quantity
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

    -- LINE-TREATMENT (b): audited VENDOR_RETURN movements, one per source
    -- location, serialized per item+location against concurrent
    -- withdrawals (the same advisory lock the kiosk uses), never below
    -- zero. Quantity is entered in the item's own base unit (already
    -- resolved by line_return_base_quantity: base unit, or a fixed-
    -- conversion unit configured for the item -- never a guessed factor).
    for v_location in
      select distinct c.return_location_id as location_id, loc.timezone
        from public.purchase_document_line_classifications c
        join public.locations loc on loc.id = c.return_location_id
        left join public.purchase_document_inventory_return_lines rtl on rtl.classification_id = c.id
       where c.organization_id = p_organization_id
         and c.purchase_document_id = p_purchase_document_id
         and c.status = 'CONFIRMED'
         and c.line_treatment = 'CREDIT_RETURN'
         and c.credit_subtype = 'INVENTORY_RETURN'
         and rtl.id is null
    loop
      insert into public.inventory_movements (
        organization_id, location_id, station_id, movement_type,
        performed_by_app_user_id, business_date, notes
      ) values (
        p_organization_id, v_location.location_id, null, 'VENDOR_RETURN',
        p_app_user_id, (now() at time zone v_location.timezone)::date,
        'Vendor return posted from purchase document ' || p_purchase_document_id::text
      ) returning id into v_movement_id;
      v_movement_count := v_movement_count + 1;

      for v_return in
        select c.id as classification_id, c.line_key, c.inventory_item_id, ii.base_unit_id, c.return_quantity, c.return_unit_code, c.return_reason
          from public.purchase_document_line_classifications c
          join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
          left join public.purchase_document_inventory_return_lines rtl on rtl.classification_id = c.id
         where c.organization_id = p_organization_id
           and c.purchase_document_id = p_purchase_document_id
           and c.status = 'CONFIRMED'
           and c.line_treatment = 'CREDIT_RETURN'
           and c.credit_subtype = 'INVENTORY_RETURN'
           and c.return_location_id = v_location.location_id
           and rtl.id is null
         order by c.line_number_snapshot nulls last, c.created_at
      loop
        v_return_base_quantity := public.line_return_base_quantity(v_return.classification_id);
        if v_return_base_quantity is null or v_return_base_quantity <= 0 then
          raise exception 'inventory return on line % has no resolvable base quantity', v_return.line_key using errcode = 'GA088';
        end if;

        perform pg_advisory_xact_lock(public.inventory_location_lock_key(p_organization_id, v_return.inventory_item_id, v_location.location_id));
        v_balance := public.inventory_location_item_balance(p_organization_id, v_return.inventory_item_id, v_location.location_id);
        if v_return_base_quantity > v_balance then
          raise exception 'inventory return on line % would take inventory_item % below zero at location % (on hand %, returning %)',
            v_return.line_key, v_return.inventory_item_id, v_location.location_id, v_balance, v_return_base_quantity
            using errcode = 'GA022',
                  detail = jsonb_build_object('lineKey', v_return.line_key, 'availableQuantity', v_balance, 'requestedQuantity', v_return_base_quantity)::text;
        end if;

        insert into public.inventory_movement_lines (
          movement_id, inventory_item_id, entered_quantity, entered_unit_id
        ) values (
          v_movement_id, v_return.inventory_item_id, v_return_base_quantity, v_return.base_unit_id
        ) returning id into v_movement_line_id;

        insert into public.purchase_document_inventory_return_lines (
          organization_id, posting_id, classification_id, line_key, movement_id, movement_line_id,
          inventory_item_id, location_id, posted_base_quantity, base_unit_id
        )
        select p_organization_id, v_posting_id, v_return.classification_id, v_return.line_key, v_movement_id, ml.id,
               ml.inventory_item_id, v_location.location_id, ml.normalized_base_quantity, ml.base_unit_id
          from public.inventory_movement_lines ml
         where ml.id = v_movement_line_id;

        insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
        values (p_organization_id, p_app_user_id, 'INVENTORY_RETURN_POSTED', 'inventory_item', v_return.inventory_item_id,
                jsonb_build_object('balance', v_balance),
                jsonb_build_object('purchaseDocumentId', p_purchase_document_id, 'lineKey', v_return.line_key, 'postingId', v_posting_id,
                                   'movementId', v_movement_id, 'locationId', v_location.location_id,
                                   'returnQuantity', v_return.return_quantity, 'returnUnitCode', v_return.return_unit_code,
                                   'baseQuantity', v_return_base_quantity, 'balance', v_balance - v_return_base_quantity,
                                   'reason', v_return.return_reason));

        v_posted_count := v_posted_count + 1;
      end loop;
    end loop;

    if v_posted_count = 0 then
      -- Every candidate was posted by a concurrent winner between our
      -- eligibility snapshot and the insert loops -- converge exactly like
      -- a direct unique-violation loser (rolls back this caller's empty
      -- posting header via the handler below).
      raise exception 'concurrent posting already posted every line' using errcode = '23505';
    end if;

    -- Every genuine restock sets the POST-restock balance as the new 100%
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
    -- A concurrent post won the race on receipt_line_id / classification_id
    -- -- everything this caller inserted above is rolled back; report the
    -- winner's posting.
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

-- ============================================================
-- 13. Posting-status read model (20260811100064) -- inventory returns
--     count as required/posted lines too, so a returns-only document
--     reads POSTED after posting rather than NOT_POSTED forever.
-- ============================================================
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
    union all
    select c.id,
           (rtl.id is not null) as posted
      from public.purchase_document_line_classifications c
      left join public.purchase_document_inventory_return_lines rtl on rtl.classification_id = c.id
     where c.organization_id = p_organization_id
       and c.purchase_document_id = p_purchase_document_id
       and c.status = 'CONFIRMED'
       and c.line_treatment = 'CREDIT_RETURN'
       and c.credit_subtype = 'INVENTORY_RETURN'
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

-- ============================================================
-- 14. post_purchase_document_sole_approver -- reproduced from
--     20260811100134 with: the manager's acceptance of AI-assigned
--     proposals applied first (same transaction, before every gate); a
--     per-treatment summary in the result/audit; and NO_INVENTORY_CHANGES
--     handled as a successful expense-only post. The OUT row type grows,
--     so the old signature is dropped first (CREATE OR REPLACE cannot
--     change OUT parameters).
-- ============================================================
drop function if exists public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid);

create function public.post_purchase_document_sole_approver(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_reason text,
  p_notes text,
  p_idempotency_key uuid default null
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_verified_at timestamptz,
  out_verification_method text,
  out_posting_status text,
  out_posting_id uuid,
  out_posted_line_count integer,
  out_movement_count integer,
  out_invoice_total numeric,
  out_inventory_value numeric,
  out_inventory_line_count integer,
  out_expense_line_count integer,
  out_credit_line_count integer,
  out_discount_line_count integer,
  out_tax_line_count integer,
  out_return_line_count integer,
  out_accepted_line_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_version integer;
  v_revision_group_id uuid;
  v_document_date date;
  v_total numeric;
  v_document_number text;
  v_vendor_id uuid;
  v_new_version integer;
  v_verified_at timestamptz;
  v_inventory_value numeric;
  v_inventory_line_count integer;
  v_expense_line_count integer;
  v_credit_line_count integer;
  v_discount_line_count integer;
  v_tax_line_count integer;
  v_return_line_count integer;
  v_accepted_count integer;
  v_actor_name text;
  v_locations jsonb;
  v_posting record;
  v_notify_error text;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required for single-manager approval' using errcode = 'GA078';
  end if;

  select status, version, revision_group_id, document_date, total, document_number, vendor_id
    into v_status, v_version, v_revision_group_id, v_document_date, v_total, v_document_number, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.post_without_second_review') then
    raise exception 'app_user % does not have permission to post without a second reviewer', p_app_user_id
      using errcode = 'GA076';
  end if;

  if v_status <> 'DRAFT' or v_version <> p_expected_version then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- LINE-TREATMENT: the posting manager accepts every still-pending
  -- high-confidence proposal as their own decision (audited per line)
  -- before any completeness gate runs -- idempotent with the acceptance
  -- already applied when they left Review Invoice.
  v_accepted_count := public.accept_ai_assigned_line_classifications(p_organization_id, p_purchase_document_id, p_app_user_id);

  if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has incomplete item mapping/receiving preparation', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_has_implausible_date(v_document_date) then
    raise exception 'purchase_document % has an implausible document date', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if exists (
    select 1
      from public.purchase_document_inventory_postings pip
      join public.purchase_documents sibling
        on sibling.id = pip.purchase_document_id and sibling.organization_id = p_organization_id
     where pip.organization_id = p_organization_id
       and sibling.revision_group_id = v_revision_group_id
       and sibling.id <> p_purchase_document_id
  ) then
    raise exception 'purchase_document % cannot post -- another revision in this amendment lineage has already posted inventory for this business document', p_purchase_document_id
      using errcode = 'GA075';
  end if;

  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         verification_method = 'SOLE_APPROVER',
         sole_approver_reason = btrim(p_reason),
         sole_approver_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version, pd.verified_at into v_new_version, v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  select
    coalesce(sum(pdl.line_total) filter (where c.line_treatment = 'INVENTORY_PURCHASE'), 0),
    count(*) filter (where c.line_treatment = 'INVENTORY_PURCHASE'),
    count(*) filter (where c.line_treatment in ('EXPENSE', 'FREIGHT_FEE')),
    count(*) filter (where c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype <> 'INVENTORY_RETURN'),
    count(*) filter (where c.line_treatment = 'DISCOUNT'),
    count(*) filter (where c.line_treatment = 'TAX'),
    count(*) filter (where c.line_treatment = 'CREDIT_RETURN' and c.credit_subtype = 'INVENTORY_RETURN')
    into v_inventory_value, v_inventory_line_count, v_expense_line_count, v_credit_line_count, v_discount_line_count, v_tax_line_count, v_return_line_count
    from public.purchase_document_lines pdl
    join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
   where pdl.purchase_document_id = p_purchase_document_id
     and pdl.organization_id = p_organization_id;

  select coalesce(jsonb_agg(distinct l.name), '[]'::jsonb)
    into v_locations
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    join public.locations l on l.id = rl.location_id and l.organization_id = p_organization_id
   where rl.matched_line_key is not null;

  select (e.first_name || ' ' || e.last_name) into v_actor_name
    from public.app_users au
    join public.employees e on e.id = au.employee_id
   where au.id = p_app_user_id and au.organization_id = p_organization_id;

  select * into v_posting from public.post_purchase_document_inventory(p_purchase_document_id, p_organization_id, p_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_POSTED_SOLE_APPROVER', 'purchase_document', p_purchase_document_id,
    jsonb_build_object(
      'purchaseDocumentId', p_purchase_document_id,
      'revisionGroupId', v_revision_group_id,
      'actorAppUserId', p_app_user_id,
      'actorName', v_actor_name,
      'permissionUsed', 'purchase_documents.post_without_second_review',
      'reason', btrim(p_reason),
      'notes', nullif(btrim(coalesce(p_notes, '')), ''),
      'occurredAt', v_verified_at,
      'invoiceTotal', v_total,
      'inventoryValue', v_inventory_value,
      'inventoryLineCount', v_inventory_line_count,
      'expenseLineCount', v_expense_line_count,
      'creditLineCount', v_credit_line_count,
      'discountLineCount', v_discount_line_count,
      'taxLineCount', v_tax_line_count,
      'inventoryReturnLineCount', v_return_line_count,
      'aiAcceptedLineCount', v_accepted_count,
      'postingStatus', v_posting.out_status,
      'postingId', v_posting.out_posting_id,
      'postedLineCount', v_posting.out_posted_line_count,
      'movementCount', v_posting.out_movement_count,
      'idempotencyKey', p_idempotency_key,
      'vendorId', v_vendor_id,
      'documentNumber', v_document_number,
      'locations', v_locations
    )
  );

  begin
    insert into public.user_notifications (organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata)
    select p_organization_id, au.id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_POSTED', 'purchase_document', p_purchase_document_id,
           'Invoice posted by sole approver',
           coalesce(v_actor_name, 'A manager') || ' posted purchase document ' || coalesce(v_document_number, p_purchase_document_id::text) ||
             ' without a second reviewer.',
           jsonb_build_object('reason', btrim(p_reason), 'invoiceTotal', v_total)
      from public.app_users au
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id and r.name = 'admin'
     where au.organization_id = p_organization_id
       and au.is_active
       and au.id <> p_app_user_id;
  exception when others then
    v_notify_error := sqlerrm;
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (
      p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_NOTIFICATION_FAILED', 'purchase_document', p_purchase_document_id,
      jsonb_build_object('error', v_notify_error)
    );
  end;

  return query select
    p_purchase_document_id, 'VERIFIED'::text, v_verified_at, 'SOLE_APPROVER'::text,
    v_posting.out_status, v_posting.out_posting_id, v_posting.out_posted_line_count, v_posting.out_movement_count,
    v_total, v_inventory_value, v_inventory_line_count, v_expense_line_count,
    v_credit_line_count, v_discount_line_count, v_tax_line_count, v_return_line_count, v_accepted_count;
end;
$$;

revoke all on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) from public;
grant execute on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) to service_role;
