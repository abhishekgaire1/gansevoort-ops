-- Move the price-review posting guard from the postings HEADER (before
-- insert) to the posting LINES (after insert, statement-level with a
-- transition table). The header fires before any line exists, so the header
-- guard could only see the effective-receipt verified base quantity -- which
-- is null for SAME_UNIT / FIXED_CONVERSION lines, silently skipping their
-- enforcement. The posting lines carry the AUTHORITATIVE posted_base_quantity
-- for EVERY receiving behavior, so computing the current normalized price
-- from them is correct for all lines and matches exactly what is posted.
--
-- Still transactional and fail-closed: the trigger runs in the posting
-- transaction; a violation rolls back the whole posting. Still covers every
-- posting path (they all insert posting lines). Currency that cannot be
-- normalized is treated as "no comparison" (never blocks), consistent with
-- the Step 2 review.

drop trigger if exists assert_price_review_before_posting on public.purchase_document_inventory_postings;

create or replace function public.trg_assert_price_review_after_posting_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_violations integer;
begin
  with newl as (
    select posting_id, receipt_line_id, inventory_item_id, base_unit_id, posted_base_quantity
    from new_lines
  ),
  per_line as (
    select
      pd.id as purchase_document_id,
      pd.organization_id,
      pd.vendor_id,
      pd.document_date,
      public.normalize_currency_code(pd.currency) as currency,
      rl.matched_line_key as line_key,
      newl.inventory_item_id,
      pdl.vendor_sku,
      bu.code as base_unit_code,
      pdl.line_total,
      sum(newl.posted_base_quantity) as base_qty
    from newl
    join public.purchase_document_inventory_postings pdp on pdp.id = newl.posting_id
    join public.purchase_documents pd on pd.id = pdp.purchase_document_id and pd.organization_id = pdp.organization_id
    join public.receipt_lines rl on rl.id = newl.receipt_line_id and rl.organization_id = pd.organization_id
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = pd.id and pdl.organization_id = pd.organization_id and pdl.line_key = rl.matched_line_key
    join public.units bu on bu.id = newl.base_unit_id
    where newl.inventory_item_id is not null
    group by pd.id, pd.organization_id, pd.vendor_id, pd.document_date, public.normalize_currency_code(pd.currency),
             rl.matched_line_key, newl.inventory_item_id, pdl.vendor_sku, bu.code, pdl.line_total
  ),
  priced as (
    select per_line.*,
           case when base_qty > 0 and line_total > 0 then line_total / base_qty else null end as current_unit_cost
    from per_line
    where currency is not null  -- no normalizable currency -> no comparison -> nothing to enforce
  ),
  compared as (
    select priced.*, b.out_purchase_document_id as prev_pd, b.out_unit_cost as prev_unit_cost,
           case when priced.current_unit_cost is not null and b.out_unit_cost is not null and b.out_unit_cost <> 0
                then abs((priced.current_unit_cost - b.out_unit_cost) / b.out_unit_cost) * 100 else null end as delta_pct
    from priced
    left join lateral public.get_comparable_price_baseline(
      priced.organization_id, priced.vendor_id, priced.inventory_item_id, priced.vendor_sku, priced.currency, priced.base_unit_code, priced.document_date, priced.purchase_document_id
    ) b on true
    where priced.current_unit_cost is not null
  )
  select count(*) into v_violations
  from compared
  where delta_pct is not null and delta_pct >= 20
    and not exists (
      select 1 from public.price_change_acknowledgments a
       where a.organization_id = compared.organization_id
         and a.purchase_document_id = compared.purchase_document_id
         and a.line_key = compared.line_key
         and a.inventory_item_id = compared.inventory_item_id
         and a.vendor_id = compared.vendor_id
         and public.normalize_currency_code(a.currency) is not distinct from compared.currency
         and upper(btrim(coalesce(a.vendor_sku, ''))) = upper(btrim(coalesce(compared.vendor_sku, '')))
         and a.previous_purchase_document_id is not distinct from compared.prev_pd
         and round(a.previous_unit_cost, 6) = round(compared.prev_unit_cost, 6)
         and round(a.current_unit_cost, 6) = round(compared.current_unit_cost, 6)
    );

  if v_violations > 0 then
    raise exception 'This invoice contains a significant price change that must be reviewed again before inventory can be posted.'
      using errcode = 'GA079';
  end if;
  return null;
end;
$$;

create trigger assert_price_review_after_posting_lines
  after insert on public.purchase_document_inventory_posting_lines
  referencing new table as new_lines
  for each statement execute function public.trg_assert_price_review_after_posting_lines();
