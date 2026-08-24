-- Flat Category Architecture + Manager Category Drill-Downs milestone.
--
-- ============================================================
-- WHAT ALREADY EXISTED (verified by direct inspection before writing this
-- migration):
-- ============================================================
-- inventory_categories (20260811100004) has NO parent_id at all -- it was
-- always flat. Nothing to change there.
--
-- spend_categories (20260811100035) is genuinely hierarchical, and the
-- REAL Gansevoort organization has a live 2-level tree seeded by
-- scripts/seed-canonical-categories.ts: 3 root categories (Food &
-- Beverage, Operating Supplies, Other Operating Costs) with 20 total leaf
-- children. Direct inspection of live data confirms BOTH levels carry
-- real references -- "Food & Beverage" (a ROOT) is directly referenced by
-- inventory_items.spend_category_id, not merely its children (e.g.
-- "Dairy & Eggs", "Beverages"). This is exactly the "parent itself has
-- transactions AND children also have transactions" case the milestone
-- spec calls out -- categories are therefore FLATTENED (parent_id set to
-- null), never merged, and every one of the 23 rows keeps its own id.
-- No name collisions exist among the 23 names at any level, so flattening
-- cannot violate the existing case-insensitive uniqueness index.
--
-- No business/financial logic anywhere reads parent_id -- the only
-- consumer found (getReviewSummary.ts's buildSpendCategoryPathResolver)
-- is purely a presentational "Root > Child" path builder for display,
-- which the new flat UI no longer needs.
--
-- What this migration does:
--   1. Flattens existing spend_categories data (parent_id -> null),
--      preserving every row's id.
--   2. Simplifies create_spend_category to a flat 3-argument signature
--      (drops the old 4-argument p_parent_id overload explicitly, rather
--      than leaving two overloads around -- this codebase has twice
--      already had real bugs from RPC overload ambiguity, 20260811100052
--      and 20260811100062).
--
-- What this migration deliberately does NOT do:
--   - Does not drop the parent_id column (Part 5: safer to leave it
--     present-but-unused than to destructively remove it; a future
--     Reporting Group feature is a SEPARATE mechanism, never built by
--     resurrecting this column -- Part 40).
--   - Does not drop prevent_spend_category_cycle -- harmless with an
--     always-null parent_id, and remains a defensive guard if a parent_id
--     were ever hand-set directly against the database again.
--   - Does not touch the two existing partial unique indexes
--     (spend_categories_org_root_lower_name_key /
--     spend_categories_org_parent_lower_name_key) -- once every row's
--     parent_id is null, the "root" index alone becomes the sole
--     effective duplicate guard, which is exactly flat, per-org,
--     per-category-type uniqueness (Part 11).
-- ============================================================

-- ============================================================
-- 1. Flatten existing data. Same ids, same historical references --
--    nothing is deleted, renamed, or merged.
-- ============================================================
update public.spend_categories
   set parent_id = null
 where parent_id is not null;

-- ============================================================
-- 2. Simplify category creation to flat-only. The old 4-argument
--    signature (with p_parent_id default null) is DROPPED explicitly --
--    not left alongside a new 3-argument one -- so exactly one
--    create_spend_category function exists going forward.
-- ============================================================
drop function if exists public.create_spend_category(uuid, uuid, text, uuid);

create function public.create_spend_category(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_name text
)
returns table (out_category_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
  v_category_id uuid;
begin
  if v_name = '' then
    raise exception 'category name is required';
  end if;

  select id into v_category_id
    from public.spend_categories
   where organization_id = p_organization_id and parent_id is null and lower(name) = lower(v_name);

  if found then
    raise exception 'a spend category named "%" already exists', v_name
      using errcode = 'GA014';
  end if;

  insert into public.spend_categories (organization_id, name, parent_id)
  values (p_organization_id, v_name, null)
  returning id into v_category_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'SPEND_CATEGORY_CREATED', 'spend_category', v_category_id, jsonb_build_object('name', v_name));

  return query select v_category_id;
end;
$$;

revoke all on function public.create_spend_category(uuid, uuid, text) from public;
grant execute on function public.create_spend_category(uuid, uuid, text) to service_role;

-- ============================================================
-- 3. Manager Expense Category read model (Part 45). The authoritative
--    inclusion rule (Phase A inspection):
--      purchase_documents.status = 'VERIFIED'          (Manager 2's
--        correction overlay is only promoted into authoritative state by
--        Final Verify -- see 20260811100071's own header comment: "Only
--        Final Verify promotes the reviewed corrected state into the
--        VERIFIED authoritative state." A READY_FOR_VERIFICATION or DRAFT
--        document is still provisional/correctable and must never be
--        counted as real spend.)
--      AND purchase_document_line_classifications.status = 'CONFIRMED'
--      AND purchase_document_line_classifications.disposition = 'NON_INVENTORY'
--    Filtered on purchase_documents.document_date (a plain date column,
--    not timestamptz) -- the invoice's own date, matching how a manager
--    actually thinks about "what did we spend on this day," independent
--    of when it happened to be verified in the system.
--
--    CREDIT_MEMO documents are explicitly EXCLUDED, not sign-flipped:
--    direct inspection (Phase A) found no negative-amount/credit
--    accounting semantics anywhere in the current schema or business
--    logic -- document_type is purely a label used for duplicate
--    detection/filenames/form copy today. Inventing a sign convention
--    would be calculating incorrectly; the milestone spec explicitly
--    prefers excluding and reporting over that. out_excluded_credit_memo_
--    count on the summary/totals RPCs surfaces this honestly instead of
--    silently dropping data.
-- ============================================================
create or replace function public.get_expense_category_totals(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  out_category_id uuid,
  out_total_amount numeric,
  out_line_count bigint,
  out_excluded_credit_memo_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    plc.spend_category_id,
    coalesce(sum(pdl.line_total) filter (where coalesce(pd.document_type, '') <> 'CREDIT_MEMO'), 0)::numeric,
    count(*) filter (where coalesce(pd.document_type, '') <> 'CREDIT_MEMO'),
    count(*) filter (where pd.document_type = 'CREDIT_MEMO')
  from public.purchase_document_line_classifications plc
  join public.purchase_documents pd
    on pd.id = plc.purchase_document_id and pd.organization_id = plc.organization_id
  join public.purchase_document_lines pdl
    on pdl.purchase_document_id = plc.purchase_document_id and pdl.line_key = plc.line_key and pdl.organization_id = plc.organization_id
 where plc.organization_id = p_organization_id
   and plc.disposition = 'NON_INVENTORY'
   and plc.status = 'CONFIRMED'
   and plc.spend_category_id is not null
   and pd.status = 'VERIFIED'
   and pd.document_date >= p_start_date
   and pd.document_date <= p_end_date
 group by plc.spend_category_id;
$$;

revoke all on function public.get_expense_category_totals(uuid, date, date) from public;
grant execute on function public.get_expense_category_totals(uuid, date, date) to service_role;

create or replace function public.get_expense_category_summary(
  p_organization_id uuid,
  p_category_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  out_total_amount numeric,
  out_line_count bigint,
  out_excluded_credit_memo_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(pdl.line_total) filter (where coalesce(pd.document_type, '') <> 'CREDIT_MEMO'), 0)::numeric,
    count(*) filter (where coalesce(pd.document_type, '') <> 'CREDIT_MEMO'),
    count(*) filter (where pd.document_type = 'CREDIT_MEMO')
  from public.purchase_document_line_classifications plc
  join public.purchase_documents pd
    on pd.id = plc.purchase_document_id and pd.organization_id = plc.organization_id
  join public.purchase_document_lines pdl
    on pdl.purchase_document_id = plc.purchase_document_id and pdl.line_key = plc.line_key and pdl.organization_id = plc.organization_id
 where plc.organization_id = p_organization_id
   and plc.spend_category_id = p_category_id
   and plc.disposition = 'NON_INVENTORY'
   and plc.status = 'CONFIRMED'
   and pd.status = 'VERIFIED'
   and pd.document_date >= p_start_date
   and pd.document_date <= p_end_date;
$$;

revoke all on function public.get_expense_category_summary(uuid, uuid, date, date) from public;
grant execute on function public.get_expense_category_summary(uuid, uuid, date, date) to service_role;

-- Recent-lines drill-down (Part 24/30) -- bounded, paginated, never an
-- unbounded fetch. CREDIT_MEMO lines are excluded here too, consistent
-- with the totals above -- never shown as if they were ordinary spend.
create or replace function public.get_expense_category_lines(
  p_organization_id uuid,
  p_category_id uuid,
  p_start_date date,
  p_end_date date,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  out_line_id uuid,
  out_description text,
  out_line_total numeric,
  out_document_id uuid,
  out_document_number text,
  out_document_type text,
  out_document_date date,
  out_vendor_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select plc.id, pdl.description, pdl.line_total, pd.id, pd.document_number, pd.document_type, pd.document_date, v.name
    from public.purchase_document_line_classifications plc
    join public.purchase_documents pd
      on pd.id = plc.purchase_document_id and pd.organization_id = plc.organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = plc.purchase_document_id and pdl.line_key = plc.line_key and pdl.organization_id = plc.organization_id
    left join public.vendors v on v.id = pd.vendor_id and v.organization_id = pd.organization_id
   where plc.organization_id = p_organization_id
     and plc.spend_category_id = p_category_id
     and plc.disposition = 'NON_INVENTORY'
     and plc.status = 'CONFIRMED'
     and pd.status = 'VERIFIED'
     and coalesce(pd.document_type, '') <> 'CREDIT_MEMO'
     and pd.document_date >= p_start_date
     and pd.document_date <= p_end_date
   order by pd.document_date desc, plc.created_at desc
   limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.get_expense_category_lines(uuid, uuid, date, date, integer, integer) from public;
grant execute on function public.get_expense_category_lines(uuid, uuid, date, date, integer, integer) to service_role;

-- ============================================================
-- 4. Manager Inventory Category item counts (Part 19/46) -- ONE
--    aggregate query for the list page (Part 43: never N+1). The detail
--    page reuses the EXISTING list_inventory_balances RPC
--    (app/lib/inventory/listInventoryBalances.ts) filtered by category
--    in TypeScript -- no new balance formula, per Part 20/46.
-- ============================================================
create or replace function public.get_inventory_category_item_counts(
  p_organization_id uuid
)
returns table (
  out_category_id uuid,
  out_item_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select category_id, count(*)
    from public.inventory_items
   where organization_id = p_organization_id
     and disposition = 'INVENTORY'
     and approval_status = 'CONFIRMED'
     and status = 'active'
     and category_id is not null
   group by category_id;
$$;

revoke all on function public.get_inventory_category_item_counts(uuid) from public;
grant execute on function public.get_inventory_category_item_counts(uuid) to service_role;
