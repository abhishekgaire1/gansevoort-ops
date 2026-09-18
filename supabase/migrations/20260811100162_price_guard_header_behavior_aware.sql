-- Final form of the posting-boundary price guard.
--
-- The statement-level trigger on posting_lines (20260811100160, dropped by
-- 20260811100161) computed the current price from posted_base_quantity, but
-- a transition-table statement trigger on that table interfered with the
-- posting function's own balance/movement writes (a fresh SAME_UNIT post
-- lost its location balance). The BEFORE INSERT trigger on the postings
-- HEADER (20260811100156/158) is posting-safe -- it never fired on
-- posting_lines -- but the original guard read only the verified base
-- quantity, which is null for SAME_UNIT / FIXED_CONVERSION lines, so it
-- silently skipped enforcing them.
--
-- This version keeps the safe HEADER trigger and computes the current
-- normalized base quantity the SAME way computeCurrentBaseQuantity does in
-- TypeScript (priceComparison.ts): measured -> verified base qty;
-- received-unit-equals-base -> received qty; received-unit-equals-purchase
-- -> received qty x confirmed conversion factor; otherwise unresolved (no
-- comparison). So the guard and the acknowledgment (whose current price
-- comes from that TS path) agree, and every receiving behavior is enforced.
-- Still fails closed, still in the posting transaction, still covers every
-- posting path (all insert a postings header), still skips a currency that
-- cannot be normalized.

create or replace function public.assert_price_review_acknowledged(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_before date;
  v_vendor_id uuid;
  v_violations integer;
begin
  perform 1 from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for no key update;

  select public.normalize_currency_code(currency), document_date, vendor_id
    into v_currency, v_before, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_currency is null then
    return;  -- no normalizable currency -> no comparison -> nothing to enforce
  end if;

  with cur as (
    select
      c.line_key,
      c.inventory_item_id,
      pdl.vendor_sku,
      bu.code as base_unit_code,
      pdl.line_total,
      sum(
        case
          when coalesce(vpu.receiving_behavior, 'SAME_UNIT') in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
            then rl.actual_verified_base_quantity
          when upper(btrim(coalesce(rl.actual_received_package_unit, ''))) = upper(btrim(bu.code))
            then rl.actual_received_package_quantity
          when vpu.id is not null and pu.code is not null
               and upper(btrim(coalesce(rl.actual_received_package_unit, ''))) = upper(btrim(pu.code))
               and vpu.conversion_factor is not null
            then rl.actual_received_package_quantity * vpu.conversion_factor
          else null
        end
      ) as base_qty
    from public.purchase_document_line_classifications c
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = p_purchase_document_id and pdl.organization_id = p_organization_id and pdl.line_key = c.line_key
    join public.inventory_items ii
      on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
    join public.units bu on bu.id = ii.base_unit_id
    left join public.vendor_item_purchase_units vpu
      on vpu.id = c.vendor_item_purchase_unit_id and vpu.organization_id = p_organization_id
    left join public.units pu on pu.id = vpu.purchase_unit_id
    join public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er on true
    join public.receipt_lines rl
      on rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key = c.line_key
    where c.organization_id = p_organization_id
      and c.purchase_document_id = p_purchase_document_id
      and c.status = 'CONFIRMED'
      and c.disposition = 'INVENTORY'
      and c.inventory_item_id is not null
    group by c.line_key, c.inventory_item_id, pdl.vendor_sku, bu.code, pdl.line_total
  ),
  priced as (
    select cur.*,
           case when cur.base_qty > 0 and cur.line_total > 0 then cur.line_total / cur.base_qty else null end as current_unit_cost
    from cur
  ),
  compared as (
    select priced.*, b.out_purchase_document_id as prev_pd, b.out_unit_cost as prev_unit_cost,
           case when priced.current_unit_cost is not null and b.out_unit_cost is not null and b.out_unit_cost <> 0
                then abs((priced.current_unit_cost - b.out_unit_cost) / b.out_unit_cost) * 100 else null end as delta_pct
    from priced
    left join lateral public.get_comparable_price_baseline(
      p_organization_id, v_vendor_id, priced.inventory_item_id, priced.vendor_sku, v_currency, priced.base_unit_code, v_before, p_purchase_document_id
    ) b on true
    where priced.current_unit_cost is not null
  )
  select count(*) into v_violations
  from compared
  where delta_pct is not null and delta_pct >= 20
    and not exists (
      select 1 from public.price_change_acknowledgments a
       where a.organization_id = p_organization_id
         and a.purchase_document_id = p_purchase_document_id
         and a.line_key = compared.line_key
         and a.inventory_item_id = compared.inventory_item_id
         and a.vendor_id = v_vendor_id
         and public.normalize_currency_code(a.currency) is not distinct from v_currency
         and upper(btrim(coalesce(a.vendor_sku, ''))) = upper(btrim(coalesce(compared.vendor_sku, '')))
         and a.previous_purchase_document_id is not distinct from compared.prev_pd
         and round(a.previous_unit_cost, 6) = round(compared.prev_unit_cost, 6)
         and round(a.current_unit_cost, 6) = round(compared.current_unit_cost, 6)
    );

  if v_violations > 0 then
    raise exception 'This invoice contains a significant price change that must be reviewed again before inventory can be posted.'
      using errcode = 'GA079';
  end if;
end;
$$;

-- Re-attach the posting-safe HEADER trigger (the lines trigger was dropped
-- by 20260811100161).
create trigger assert_price_review_before_posting
  before insert on public.purchase_document_inventory_postings
  for each row execute function public.trg_assert_price_review_before_posting();
