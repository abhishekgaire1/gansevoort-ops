-- Vendor-aware Price History for Current Inventory -- read-only
-- historical purchase pricing, never an accounting inventory valuation
-- (no weighted-average, FIFO, COGS, or stock-value math anywhere here).
-- One internal events function + two read-only RPCs + two indexes; no
-- new tables, no write-path change of any kind.
--
-- WHY NEW RPCS instead of extending get_inventory_item_price_history
-- (20260811100106): that RPC is the hardened primitive behind Confirm
-- Items' inline "vs previous" indicators and the Ask Gansevoort cost
-- pipeline, and it deliberately EXCLUDES everything this feature must
-- INCLUDE -- measured-at-receiving lines, rows whose price cannot be
-- computed (it filters them; this feature must SHOW them as "price
-- unavailable"), correction/amendment awareness, received dates, vendor
-- SKUs, and per-(document, line) pagination identity. Widening it would
-- change behavior for its existing callers; these siblings reuse the
-- exact same proven join lineage instead.
--
-- ELIGIBILITY IS STRUCTURAL, NOT FILTERED: the source is
-- purchase_document_inventory_posting_lines, whose rows can only ever be
-- created by post_purchase_document_inventory against a VERIFIED
-- document's confirmed INVENTORY-disposition lines (20260811100064).
-- Draft/unposted/discarded documents, expense (NON_INVENTORY) lines,
-- manual adjustments, kiosk withdrawals, waste, transfers, and cycle
-- counts can never appear here because they never produce posting lines
-- -- there is nothing to exclude.
--
-- ONE PRICE EVENT PER (posted document, invoice line): posting lines are
-- grouped by (purchase_document_id, receipt_lines.matched_line_key). A
-- split-location delivery (one invoice line posted to several locations)
-- and a genuine additional delivery on the same line both sum into the
-- SAME event -- line_total is a per-line fact and is never counted
-- twice. Amendments cannot re-post (GA075 guard, 20260811100132), so an
-- amendment lineage contributes AT MOST one event per line, on whichever
-- revision posted -- duplicate-event risk is structurally zero.
--
-- AUTHORITATIVE RECEIVED QUANTITY = sum(posted_base_quantity)
-- + sum(inventory_corrections.quantity_delta) over the group's posting
-- lines (RECEIPT_PACKAGE_FACTOR corrections, joined by
-- source_posting_line_id). This matches the movements ledger exactly:
-- each correction inserted its own delta movement (20260811100146), so
-- posted + deltas is what the balance ledger actually did.
--
-- NORMALIZED PRICE = line_total / authoritative quantity, only when
-- line_total > 0 and quantity > 0; otherwise NULL with a reason code --
-- the row still returns (the UI must show it as unavailable, never as
-- $0.00). Freight/tax/fees/invoice-level discounts are NOT allocated to
-- lines anywhere in this schema, so they are simply absent from the
-- normalized figure -- the UI discloses that.
--
-- COMPLETENESS: for SAME_UNIT/FIXED_CONVERSION package snapshots (the
-- classification's own vendor_item_purchase_unit_id -- the version
-- confirmed FOR THAT LINE at that time, never today's package applied
-- retroactively), expected = package_quantity x factor; a >0.01 absolute
-- deviation WITHOUT a correction means the receipt was partial/abnormal
-- and dividing the full line_total by it would fabricate a wrong unit
-- price -- reason 'QUANTITY_MISMATCH', price NULL. A corrected event is
-- authoritative by decree (an admin explicitly reviewed the impact).
-- MEASURE/COUNT_EACH_DELIVERY lines have no expectation: the measured
-- quantity IS the truth, so their price always computes when positive.
--
-- AMENDED = the posted document is no longer
-- current_verified_purchase_document_revision_id() of its group. The
-- event keeps the POSTED revision's pricing (amendment lines get fresh
-- line_keys -- 20260811100029 -- so re-attributing an amendment's line
-- to a posted receipt is guesswork, which this feature refuses to do);
-- out_current_revision_id lets the UI link to the visible revision.
--
-- PAGINATION is keyset ((received_at, purchase_document_id, line_key)
-- descending -- deterministic for same-timestamp rows, including
-- multiple lines of the same document received together), never OFFSET,
-- so PostgREST's default row cap can never silently truncate a long
-- history: each page is at most p_limit rows by construction, and the
-- summary aggregates entirely inside SQL.

-- ============================================================
-- Indexes
-- ============================================================
-- Posting lines have only a posting_id index (20260811100064); both
-- these RPCs and app/lib/ai/tasks/chat/itemPurchaseCost.ts's vendor
-- discovery filter on (organization_id, inventory_item_id).
create index pd_inventory_posting_lines_org_item_idx
  on public.purchase_document_inventory_posting_lines (organization_id, inventory_item_id);

-- inventory_corrections is joined here by source_posting_line_id, which
-- has no index (20260811100137 indexes only (organization_id,
-- inventory_item_id)). Partial: only RECEIPT_PACKAGE_FACTOR rows carry
-- a source posting line.
create index inventory_corrections_source_posting_line_idx
  on public.inventory_corrections (source_posting_line_id)
  where source_posting_line_id is not null;

-- ============================================================
-- item_price_history_events -- INTERNAL shared event derivation
-- ============================================================
-- The single definition of "one price-history event" used by both
-- public-facing RPCs below, so the listing and the summary can never
-- disagree about eligibility or normalization. Deliberately NOT granted
-- to service_role: it has no pagination, so exposing it through
-- PostgREST would reintroduce the silent row-cap truncation this design
-- exists to avoid. The two definer RPCs below execute as the function
-- owner and may call it regardless of grants.
create function public.item_price_history_events(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_vendor_id uuid default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  purchase_document_id uuid,
  current_revision_id uuid,
  is_amended boolean,
  document_number text,
  document_date date,
  received_at timestamptz,
  vendor_id uuid,
  vendor_name text,
  vendor_sku text,
  line_key uuid,
  package_quantity numeric,
  package_unit text,
  snapshot_purchase_unit_code text,
  snapshot_receiving_behavior text,
  snapshot_conversion_factor numeric,
  line_total numeric,
  currency text,
  posted_base_quantity numeric,
  has_correction boolean,
  correction_reason text,
  authoritative_quantity numeric,
  base_unit_code text,
  normalized_price numeric,
  price_unavailable_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with events as (
    select
      pd.id as purchase_document_id,
      pd.revision_group_id,
      pd.document_number,
      pd.document_date,
      coalesce(pd.currency, 'USD') as currency,
      pd.vendor_id,
      v.name as vendor_name,
      rl.matched_line_key as line_key,
      max(r.occurred_at) as received_at,
      max(pdl.vendor_sku) as vendor_sku,
      max(pdl.package_quantity) as package_quantity,
      max(pdl.package_unit) as package_unit,
      max(pdl.line_total) as line_total,
      max(pu.code) as snapshot_purchase_unit_code,
      max(vpu.receiving_behavior) as snapshot_receiving_behavior,
      max(vpu.conversion_factor) as snapshot_conversion_factor,
      sum(pil.posted_base_quantity) as posted_base_quantity,
      max(u.code) as base_unit_code,
      coalesce(sum(corr.delta_sum), 0) as correction_delta,
      bool_or(corr.delta_sum is not null) as has_correction,
      max(corr.latest_reason) as correction_reason
    from public.purchase_document_inventory_posting_lines pil
    join public.purchase_document_inventory_postings pdp
      on pdp.id = pil.posting_id
     and pdp.organization_id = p_organization_id
    join public.purchase_documents pd
      on pd.id = pdp.purchase_document_id
     and pd.organization_id = p_organization_id
    left join public.vendors v
      on v.id = pd.vendor_id
     and v.organization_id = p_organization_id
    join public.receipt_lines rl
      on rl.id = pil.receipt_line_id
     and rl.organization_id = p_organization_id
    join public.receipts r
      on r.id = rl.receipt_id
     and r.organization_id = p_organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = pd.id
     and pdl.organization_id = p_organization_id
     and pdl.line_key = rl.matched_line_key
    left join public.purchase_document_line_classifications c
      on c.purchase_document_id = pd.id
     and c.organization_id = p_organization_id
     and c.line_key = rl.matched_line_key
    left join public.vendor_item_purchase_units vpu
      on vpu.id = c.vendor_item_purchase_unit_id
     and vpu.organization_id = p_organization_id
    left join public.units pu on pu.id = vpu.purchase_unit_id
    join public.units u on u.id = pil.base_unit_id
    left join lateral (
      select sum(ic.quantity_delta) as delta_sum,
             (array_agg(ic.reason order by ic.created_at desc))[1] as latest_reason
        from public.inventory_corrections ic
       where ic.source_posting_line_id = pil.id
         and ic.organization_id = p_organization_id
         and ic.correction_type = 'RECEIPT_PACKAGE_FACTOR'
      having count(*) > 0
    ) corr on true
    where pil.organization_id = p_organization_id
      and pil.inventory_item_id = p_inventory_item_id
      and exists (
        select 1 from public.inventory_items ii
         where ii.id = p_inventory_item_id
           and ii.organization_id = p_organization_id
           and ii.disposition = 'INVENTORY'
           and ii.approval_status = 'CONFIRMED'
      )
      and (p_vendor_id is null or pd.vendor_id = p_vendor_id)
      and (p_start_date is null or pd.document_date >= p_start_date)
      and (p_end_date is null or pd.document_date <= p_end_date)
    group by pd.id, pd.revision_group_id, pd.document_number, pd.document_date,
             pd.currency, pd.vendor_id, v.name, rl.matched_line_key
  ),
  priced as (
    select
      e.*,
      public.current_verified_purchase_document_revision_id(p_organization_id, e.revision_group_id) as cur_rev_id,
      e.posted_base_quantity + e.correction_delta as authoritative_quantity,
      case
        when e.line_total is null then 'MISSING_LINE_AMOUNT'
        when e.line_total <= 0 then 'NON_POSITIVE_LINE_AMOUNT'
        when e.posted_base_quantity + e.correction_delta <= 0 then 'NON_POSITIVE_QUANTITY'
        when not e.has_correction
             and e.snapshot_receiving_behavior in ('SAME_UNIT', 'FIXED_CONVERSION')
             and e.package_quantity is not null
             and abs(
                   (e.posted_base_quantity + e.correction_delta)
                   - (e.package_quantity * coalesce(e.snapshot_conversion_factor, 1))
                 ) > 0.01
          then 'QUANTITY_MISMATCH'
        else null
      end as unavailable_reason
    from events e
  )
  select
    p.purchase_document_id,
    coalesce(p.cur_rev_id, p.purchase_document_id),
    p.cur_rev_id is not null and p.cur_rev_id is distinct from p.purchase_document_id,
    p.document_number,
    p.document_date,
    p.received_at,
    p.vendor_id,
    p.vendor_name,
    p.vendor_sku,
    p.line_key,
    p.package_quantity,
    p.package_unit,
    p.snapshot_purchase_unit_code,
    p.snapshot_receiving_behavior,
    p.snapshot_conversion_factor,
    p.line_total,
    p.currency,
    p.posted_base_quantity,
    p.has_correction,
    p.correction_reason,
    p.authoritative_quantity,
    p.base_unit_code,
    case when p.unavailable_reason is null
         then p.line_total / p.authoritative_quantity
         else null end,
    p.unavailable_reason
  from priced p;
$$;

revoke all on function public.item_price_history_events(uuid, uuid, uuid, date, date) from public;

-- ============================================================
-- get_item_price_history -- paged per-event detail rows
-- ============================================================
create function public.get_item_price_history(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_vendor_id uuid default null,
  p_start_date date default null,
  p_end_date date default null,
  p_limit integer default 50,
  p_before_received_at timestamptz default null,
  p_before_document_id uuid default null,
  p_before_line_key uuid default null
)
returns table (
  out_purchase_document_id uuid,
  out_current_revision_id uuid,
  out_is_amended boolean,
  out_document_number text,
  out_document_date date,
  out_received_at timestamptz,
  out_vendor_id uuid,
  out_vendor_name text,
  out_vendor_sku text,
  out_line_key uuid,
  out_package_quantity numeric,
  out_package_unit text,
  out_snapshot_purchase_unit_code text,
  out_snapshot_receiving_behavior text,
  out_snapshot_conversion_factor numeric,
  out_line_total numeric,
  out_currency text,
  out_posted_base_quantity numeric,
  out_has_correction boolean,
  out_correction_reason text,
  out_authoritative_quantity numeric,
  out_base_unit_code text,
  out_normalized_price numeric,
  out_price_unavailable_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.purchase_document_id, e.current_revision_id, e.is_amended,
    e.document_number, e.document_date, e.received_at,
    e.vendor_id, e.vendor_name, e.vendor_sku, e.line_key,
    e.package_quantity, e.package_unit,
    e.snapshot_purchase_unit_code, e.snapshot_receiving_behavior, e.snapshot_conversion_factor,
    e.line_total, e.currency, e.posted_base_quantity,
    e.has_correction, e.correction_reason,
    e.authoritative_quantity, e.base_unit_code,
    e.normalized_price, e.price_unavailable_reason
  from public.item_price_history_events(
    p_organization_id, p_inventory_item_id, p_vendor_id, p_start_date, p_end_date
  ) e
  where (
    p_before_received_at is null
    or (e.received_at, e.purchase_document_id, e.line_key)
       < (p_before_received_at,
          coalesce(p_before_document_id, '00000000-0000-0000-0000-000000000000'::uuid),
          coalesce(p_before_line_key, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  order by e.received_at desc, e.purchase_document_id desc, e.line_key desc
  limit greatest(least(coalesce(p_limit, 50), 200), 1);
$$;

revoke all on function public.get_item_price_history(uuid, uuid, uuid, date, date, integer, timestamptz, uuid, uuid) from public;
grant execute on function public.get_item_price_history(uuid, uuid, uuid, date, date, integer, timestamptz, uuid, uuid) to service_role;

-- ============================================================
-- get_item_price_history_summary -- per-vendor + overall aggregates
-- ============================================================
-- One row per (vendor, currency) with a computable price in the
-- filtered window, plus ONE overall row per currency (out_vendor_id
-- null) -- powers the summary strip and Vendor Comparison in a single
-- round trip, aggregated entirely inside SQL over the FULL event set
-- (never a paged subset). Grouping by currency here is what upholds
-- "never combine different currencies in one trend calculation": a
-- vendor whose purchases span currencies appears once per currency, and
-- the TypeScript caller renders only the latest purchase's currency
-- group in the summary/chart while disclosing the rest.
create function public.get_item_price_history_summary(
  p_organization_id uuid,
  p_inventory_item_id uuid,
  p_vendor_id uuid default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  out_vendor_id uuid,
  out_vendor_name text,
  out_currency text,
  out_event_count integer,
  out_latest_price numeric,
  out_latest_received_at timestamptz,
  out_latest_package text,
  out_lowest_price numeric,
  out_highest_price numeric,
  out_first_price numeric,
  out_first_received_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with priced_events as (
    select
      e.vendor_id,
      e.vendor_name,
      e.currency,
      e.received_at,
      e.purchase_document_id as document_id,
      e.normalized_price as price,
      case
        when e.snapshot_purchase_unit_code is not null and e.snapshot_conversion_factor is not null
          then '1 ' || e.snapshot_purchase_unit_code || ' = '
               || trim(trailing '.' from trim(trailing '0' from e.snapshot_conversion_factor::text))
               || ' ' || e.base_unit_code
        when e.package_unit is not null then e.package_unit
        else e.base_unit_code
      end as package_label
    from public.item_price_history_events(
      p_organization_id, p_inventory_item_id, p_vendor_id, p_start_date, p_end_date
    ) e
    where e.normalized_price is not null
  ),
  by_vendor as (
    select
      vendor_id,
      max(vendor_name) as vendor_name,
      currency,
      count(*)::integer as event_count,
      (array_agg(price order by received_at desc, document_id desc))[1] as latest_price,
      max(received_at) as latest_received_at,
      (array_agg(package_label order by received_at desc, document_id desc))[1] as latest_package,
      min(price) as lowest_price,
      max(price) as highest_price,
      (array_agg(price order by received_at asc, document_id asc))[1] as first_price,
      min(received_at) as first_received_at
    from priced_events
    group by vendor_id, currency
  ),
  overall as (
    select
      null::uuid as vendor_id,
      null::text as vendor_name,
      currency,
      count(*)::integer as event_count,
      (array_agg(price order by received_at desc, document_id desc))[1] as latest_price,
      max(received_at) as latest_received_at,
      (array_agg(package_label order by received_at desc, document_id desc))[1] as latest_package,
      min(price) as lowest_price,
      max(price) as highest_price,
      (array_agg(price order by received_at asc, document_id asc))[1] as first_price,
      min(received_at) as first_received_at
    from priced_events
    group by currency
  )
  select * from by_vendor
  union all
  select * from overall
  order by vendor_id nulls first, event_count desc;
$$;

revoke all on function public.get_item_price_history_summary(uuid, uuid, uuid, date, date) from public;
grant execute on function public.get_item_price_history_summary(uuid, uuid, uuid, date, date) to service_role;
