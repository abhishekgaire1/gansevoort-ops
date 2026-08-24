-- V1 Reports closeout -- bug fix found via code audit: the Purchasing
-- report page lets a manager filter by Inventory Category, and applies
-- it correctly to the summary/breakdown tables (get_purchasing_report,
-- 20260811100108) -- but the SAME page's Price Changes panel silently
-- ignored the category filter entirely, since
-- get_purchasing_report_price_changes never accepted one. A manager
-- filtering to one category would see that category's totals above, but
-- an UNFILTERED (all-category) price-change list below, with no
-- indication the two panels were now looking at different scopes -- a
-- direct violation of "managers must be able to trust the numbers."
--
-- Adds p_inventory_category_id (default null, so every existing caller
-- with the old 5-argument shape keeps working via the new default) --
-- but a new parameter changes the function's argument-type signature, so
-- CREATE OR REPLACE alone would create a second overload rather than
-- replacing the deployed one; the old signature is dropped first.
drop function if exists public.get_purchasing_report_price_changes(uuid, date, date, uuid, integer);

create function public.get_purchasing_report_price_changes(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_vendor_id uuid default null,
  p_inventory_category_id uuid default null,
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
      and (p_inventory_category_id is null or ii.category_id = p_inventory_category_id)
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

revoke all on function public.get_purchasing_report_price_changes(uuid, date, date, uuid, uuid, integer) from public;
grant execute on function public.get_purchasing_report_price_changes(uuid, date, date, uuid, uuid, integer) to service_role;
