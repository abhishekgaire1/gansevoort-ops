-- V1 Purchase Price Change Intelligence -- authoritative, deterministic
-- price-history read model. One new, read-only RPC; no new tables, no
-- change to any write path.
--
-- Reuses EXACTLY the same trustworthiness/normalization pattern already
-- proven by get_inventory_item_last_received (20260811100092): unit cost
-- is purchase_document_lines.line_total divided by the ALREADY-POSTED,
-- ALREADY-NORMALIZED base quantity from
-- purchase_document_inventory_posting_lines.posted_base_quantity -- never
-- a fresh client-side unit conversion, never unit_price multiplied by an
-- unproven pack size. Only lines that actually made it through posting
-- (which itself requires the parent document to have been VERIFIED and
-- the line's receipt to have been confirmed) are ever eligible -- a
-- draft/unverified/discarded document's lines can never appear here,
-- automatically, just by virtue of the join path.
--
-- Batched by design (Part 47's "no N+1" rule): callers pass an ARRAY of
-- inventory_item_ids (e.g. every resolved INVENTORY line on the purchase
-- document currently being reviewed) and get back, in one round trip,
-- the most recent p_limit_per_item purchases of each item FROM THE SAME
-- VENDOR (Part 16's documented V1 rule: same item + same vendor + most
-- recent trustworthy purchase). Called once with limit_per_item=1 for
-- Confirm Items' inline "vs previous" indicators across an entire
-- invoice, and again with a larger limit for one item's on-demand price-
-- history drill-down.
--
-- A single purchase_document_line can legitimately post to more than one
-- location (receipt_lines.location_id is per-receipt-line, not per
-- invoice-line -- see 20260811100040's own comment on that column) --
-- summed across posting lines per (document, line) via GROUP BY so a
-- split-location delivery is never double-counted or averaged wrong.
--
-- $0/free lines (line_total = 0) and lines with no captured line_total
-- are excluded from ever being used as a PREVIOUS comparison point --
-- using the actual line_total > 0 filter rather than merely "not null"
-- guards against a genuinely free/promotional past delivery becoming a
-- misleading 100%-cheaper-then-100%-more-expensive baseline. Negative
-- (credit) lines are likewise excluded by the same filter.
create function public.get_inventory_item_price_history(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_inventory_item_ids uuid[],
  p_limit_per_item integer default 1
)
returns table (
  out_inventory_item_id uuid,
  out_rank integer,
  out_purchase_document_id uuid,
  out_document_number text,
  out_document_date date,
  out_vendor_id uuid,
  out_vendor_name text,
  out_package_quantity numeric,
  out_package_unit text,
  out_line_total numeric,
  out_base_quantity numeric,
  out_base_unit_code text,
  out_unit_cost numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with posted as (
    select
      pil.inventory_item_id,
      pd.id as purchase_document_id,
      pd.document_number,
      pd.document_date,
      pd.vendor_id,
      v.name as vendor_name,
      pdl.package_quantity,
      pdl.package_unit,
      pdl.line_total,
      sum(pil.posted_base_quantity) as base_quantity,
      max(u.code) as base_unit_code
    from public.purchase_document_inventory_posting_lines pil
    join public.purchase_document_inventory_postings pdp
      on pdp.id = pil.posting_id
     and pdp.organization_id = p_organization_id
    join public.purchase_documents pd
      on pd.id = pdp.purchase_document_id
     and pd.organization_id = p_organization_id
    join public.vendors v
      on v.id = pd.vendor_id
     and v.organization_id = p_organization_id
    join public.receipt_lines rl
      on rl.id = pil.receipt_line_id
     and rl.organization_id = p_organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = pd.id
     and pdl.organization_id = p_organization_id
     and pdl.line_key = rl.matched_line_key
    join public.units u on u.id = pil.base_unit_id
    where pil.organization_id = p_organization_id
      and pil.inventory_item_id = any(p_inventory_item_ids)
      and pd.vendor_id = p_vendor_id
      and pdl.line_total is not null
      and pdl.line_total > 0
    group by pil.inventory_item_id, pd.id, pd.document_number, pd.document_date, pd.vendor_id, v.name,
             pdl.package_quantity, pdl.package_unit, pdl.line_total
  ),
  ranked as (
    select
      posted.*,
      row_number() over (
        partition by inventory_item_id
        order by document_date desc nulls last, purchase_document_id desc
      ) as rnk,
      case when base_quantity > 0 then line_total / base_quantity else null end as unit_cost
    from posted
  )
  select
    inventory_item_id, rnk, purchase_document_id, document_number, document_date, vendor_id, vendor_name,
    package_quantity, package_unit, line_total, base_quantity, base_unit_code, unit_cost
  from ranked
  where rnk <= greatest(p_limit_per_item, 1)
    and unit_cost is not null
  order by inventory_item_id, rnk;
$$;

revoke all on function public.get_inventory_item_price_history(uuid, uuid, uuid[], integer) from public;
grant execute on function public.get_inventory_item_price_history(uuid, uuid, uuid[], integer) to service_role;
