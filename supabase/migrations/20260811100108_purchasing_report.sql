-- V1 Reports foundation -- Purchasing report (Section 29/30/31). Two
-- read-only RPCs, no new tables. Each returns one jsonb document so the
-- whole report page loads in exactly one round trip per RPC (never a
-- per-breakdown call, never client-side aggregation of raw rows).
--
-- Scope boundary (Section 29/31, deliberately NOT changed here): only
-- VERIFIED purchase_documents ever contribute -- a draft/awaiting-
-- verification/discarded document's line data is not yet trustworthy
-- financial truth. purchase_document_lines.line_total is summed AS-IS,
-- which already nets legitimate negative credit lines against positive
-- purchase lines (Section 31's "net current-document value" -- gross/
-- credit/net breakdowns are explicitly deferred, not fabricated).
-- Account/prior balances (purchase_documents.amountDue-equivalent
-- concepts) are never touched -- this only ever sums line-level data,
-- which was never where a prior balance lived in the first place.
create function public.get_purchasing_report(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_vendor_id uuid default null,
  p_inventory_category_id uuid default null,
  p_inventory_item_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with in_range_lines as (
    select
      pdl.line_key,
      pdl.line_total,
      pd.id as purchase_document_id,
      pd.vendor_id,
      v.name as vendor_name,
      c.inventory_item_id,
      ii.name as item_name,
      ii.category_id,
      ic.name as category_name
    from public.purchase_document_lines pdl
    join public.purchase_documents pd
      on pd.id = pdl.purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'VERIFIED'
     and pd.document_date between p_date_from and p_date_to
    join public.vendors v on v.id = pd.vendor_id and v.organization_id = p_organization_id
    left join public.purchase_document_line_classifications c
      on c.organization_id = p_organization_id
     and c.purchase_document_id = pd.id
     and c.line_key = pdl.line_key
     and c.status = 'CONFIRMED'
    left join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
    left join public.inventory_categories ic on ic.id = ii.category_id and ic.organization_id = p_organization_id
    where pdl.organization_id = p_organization_id
      and pdl.line_total is not null
      and (p_vendor_id is null or pd.vendor_id = p_vendor_id)
      and (p_inventory_category_id is null or ii.category_id = p_inventory_category_id)
      and (p_inventory_item_id is null or c.inventory_item_id = p_inventory_item_id)
  ),
  summary as (
    select
      coalesce(sum(line_total), 0) as total_purchase_value,
      count(distinct purchase_document_id) as document_count,
      count(distinct vendor_id) as vendor_count,
      count(distinct inventory_item_id) as item_count
    from in_range_lines
  ),
  by_vendor as (
    select coalesce(jsonb_agg(row), '[]'::jsonb) as rows from (
      select jsonb_build_object('vendorId', vendor_id, 'vendorName', vendor_name, 'totalValue', sum(line_total)) as row
      from in_range_lines
      group by vendor_id, vendor_name
      order by sum(line_total) desc
      limit 15
    ) t
  ),
  by_category as (
    select coalesce(jsonb_agg(row), '[]'::jsonb) as rows from (
      select jsonb_build_object('categoryId', category_id, 'categoryName', coalesce(category_name, 'Uncategorized / Non-Inventory'), 'totalValue', sum(line_total)) as row
      from in_range_lines
      group by category_id, category_name
      order by sum(line_total) desc
      limit 15
    ) t
  ),
  by_item as (
    select coalesce(jsonb_agg(row), '[]'::jsonb) as rows from (
      select jsonb_build_object('itemId', inventory_item_id, 'itemName', item_name, 'totalValue', sum(line_total)) as row
      from in_range_lines
      where inventory_item_id is not null
      group by inventory_item_id, item_name
      order by sum(line_total) desc
      limit 15
    ) t
  )
  select jsonb_build_object(
    'totalPurchaseValue', (select total_purchase_value from summary),
    'documentCount', (select document_count from summary),
    'vendorCount', (select vendor_count from summary),
    'itemCount', (select item_count from summary),
    'byVendor', (select rows from by_vendor),
    'byCategory', (select rows from by_category),
    'byItem', (select rows from by_item)
  );
$$;

revoke all on function public.get_purchasing_report(uuid, date, date, uuid, uuid, uuid) from public;
grant execute on function public.get_purchasing_report(uuid, date, date, uuid, uuid, uuid) to service_role;

-- ============================================================
-- Price Changes -- the largest recent increases/decreases within the
-- report's date range. Same trustworthy, posted-only, normalized-base-
-- unit-cost pattern as get_inventory_item_price_history
-- (20260811100106), organization-wide instead of scoped to one document's
-- resolved lines: "current" is the single most recent posted purchase
-- per (item, vendor) whose document_date falls in the requested range;
-- "previous" is the one immediately before it, at ANY date (so a report
-- window that starts mid-history still finds a real comparison point).
-- An item+vendor pair whose most recent purchase falls OUTSIDE the
-- requested range is simply absent from this period's list -- never
-- backfilled with a stale comparison.
create function public.get_purchasing_report_price_changes(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_vendor_id uuid default null,
  p_limit integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with posted as (
    select
      pil.inventory_item_id,
      ii.name as item_name,
      pd.id as purchase_document_id,
      pd.document_number,
      pd.document_date,
      pd.vendor_id,
      v.name as vendor_name,
      pdl.line_total,
      sum(pil.posted_base_quantity) as base_quantity,
      max(u.code) as base_unit_code
    from public.purchase_document_inventory_posting_lines pil
    join public.purchase_document_inventory_postings pdp
      on pdp.id = pil.posting_id and pdp.organization_id = p_organization_id
    join public.purchase_documents pd
      on pd.id = pdp.purchase_document_id and pd.organization_id = p_organization_id
    join public.vendors v on v.id = pd.vendor_id and v.organization_id = p_organization_id
    join public.receipt_lines rl on rl.id = pil.receipt_line_id and rl.organization_id = p_organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = pd.id
     and pdl.organization_id = p_organization_id
     and pdl.line_key = rl.matched_line_key
    join public.units u on u.id = pil.base_unit_id
    join public.inventory_items ii on ii.id = pil.inventory_item_id and ii.organization_id = p_organization_id
    where pil.organization_id = p_organization_id
      and pdl.line_total is not null
      and pdl.line_total > 0
      and (p_vendor_id is null or pd.vendor_id = p_vendor_id)
    group by pil.inventory_item_id, ii.name, pd.id, pd.document_number, pd.document_date, pd.vendor_id, v.name, pdl.line_total
  ),
  ranked as (
    select
      posted.*,
      row_number() over (partition by inventory_item_id, vendor_id order by document_date desc nulls last, purchase_document_id desc) as rnk,
      case when base_quantity > 0 then line_total / base_quantity else null end as unit_cost
    from posted
  ),
  comparisons as (
    select
      cur.inventory_item_id,
      cur.item_name,
      cur.vendor_id,
      cur.vendor_name,
      cur.base_unit_code,
      cur.unit_cost as current_unit_cost,
      cur.document_number as current_document_number,
      cur.document_date as current_document_date,
      prev.unit_cost as previous_unit_cost,
      prev.document_number as previous_document_number,
      prev.document_date as previous_document_date,
      (cur.unit_cost - prev.unit_cost) as delta_abs,
      case when prev.unit_cost <> 0 then ((cur.unit_cost - prev.unit_cost) / prev.unit_cost) * 100 else null end as delta_pct
    from ranked cur
    join ranked prev
      on prev.inventory_item_id = cur.inventory_item_id
     and prev.vendor_id = cur.vendor_id
     and prev.rnk = cur.rnk + 1
    where cur.rnk = 1
      and cur.document_date between p_date_from and p_date_to
      and cur.unit_cost is not null
      and prev.unit_cost is not null
  )
  select jsonb_build_object(
    'increases', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object(
          'itemId', inventory_item_id, 'itemName', item_name, 'vendorId', vendor_id, 'vendorName', vendor_name,
          'baseUnitCode', base_unit_code, 'currentUnitCost', current_unit_cost, 'previousUnitCost', previous_unit_cost,
          'deltaAbs', delta_abs, 'deltaPct', delta_pct,
          'currentDocumentNumber', current_document_number, 'currentDocumentDate', current_document_date,
          'previousDocumentNumber', previous_document_number, 'previousDocumentDate', previous_document_date
        ) as row
        from comparisons
        where delta_abs > 0
        order by delta_pct desc nulls last
        limit greatest(p_limit, 1)
      ) t
    ), '[]'::jsonb),
    'decreases', coalesce((
      select jsonb_agg(row) from (
        select jsonb_build_object(
          'itemId', inventory_item_id, 'itemName', item_name, 'vendorId', vendor_id, 'vendorName', vendor_name,
          'baseUnitCode', base_unit_code, 'currentUnitCost', current_unit_cost, 'previousUnitCost', previous_unit_cost,
          'deltaAbs', delta_abs, 'deltaPct', delta_pct,
          'currentDocumentNumber', current_document_number, 'currentDocumentDate', current_document_date,
          'previousDocumentNumber', previous_document_number, 'previousDocumentDate', previous_document_date
        ) as row
        from comparisons
        where delta_abs < 0
        order by delta_pct asc nulls last
        limit greatest(p_limit, 1)
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_purchasing_report_price_changes(uuid, date, date, uuid, integer) from public;
grant execute on function public.get_purchasing_report_price_changes(uuid, date, date, uuid, integer) to service_role;
