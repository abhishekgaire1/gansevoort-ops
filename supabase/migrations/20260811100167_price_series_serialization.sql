-- Cross-document price-series serialization.
--
-- 20260811100166 locks the CURRENT document's mutable inputs, but two
-- DIFFERENT invoices in the same normalized price series (org + item +
-- vendor + normalized SKU + normalized currency + base unit) could still
-- post concurrently and both select the same older baseline. This adds a
-- transaction-scoped advisory lock per affected price series, acquired by
-- every posting path BEFORE the baseline is selected and the acknowledgment
-- validated, so posts in the same series serialize: the second waits, then
-- re-selects the now-current baseline and re-validates (rejecting a stale
-- acknowledgment with GA079).
--
-- Series key (text, then hashed to a bigint advisory-lock key):
--   organization_id | inventory_item_id | vendor_id | SKU | currency | base_unit
-- where SKU is upper(btrim(vendor_sku)) or the literal '__NOSKU__' marker
-- when the line has none (so a SKU-less series never collides with a
-- SKU-bearing one), and currency is normalize_currency_code(...). Hashed
-- with hashtextextended (stable, 64-bit) for pg_advisory_xact_lock. A hash
-- collision may conservatively serialize unrelated series but can never let
-- two matching series obtain different locks.
--
-- Deterministic lock order (identical for every posting path, no deadlock):
--   1. current purchase_document row
--   2. current document input rows (lines, classifications, receipt lines,
--      vendor packages) in stable key order
--   3. distinct price-series advisory locks in sorted key order
--   4. matching acknowledgment rows (read while validating)
--   5. recompute + validate, then posting proceeds
-- Advisory locks are xact-scoped, released automatically at commit/rollback.

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
  v_series_key text;
begin
  -- 1-2. Lock the current document and every mutable price-review input,
  --      deterministic order.
  perform 1 from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for no key update;

  perform 1 from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
   order by line_key
   for no key update;

  perform 1 from public.purchase_document_line_classifications
   where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
   order by line_key
   for no key update;

  perform 1
    from public.receipt_lines rl
    join public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er on er.id = rl.receipt_id
   where rl.organization_id = p_organization_id
   order by rl.id
   for no key update of rl;

  perform 1 from public.vendor_item_purchase_units vpu
   where vpu.organization_id = p_organization_id
     and vpu.id in (
       select vendor_item_purchase_unit_id
       from public.purchase_document_line_classifications
       where purchase_document_id = p_purchase_document_id and organization_id = p_organization_id
         and vendor_item_purchase_unit_id is not null
     )
   order by vpu.id
   for no key update;

  select public.normalize_currency_code(currency), document_date, vendor_id
    into v_currency, v_before, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_currency is null then
    return;  -- no normalizable currency -> no comparison -> nothing to serialize/enforce
  end if;

  -- 3. Acquire one xact advisory lock per distinct affected price series, in
  --    sorted key order (conservative: every confirmed inventory line, since
  --    which lines end up significant is only known after the baseline,
  --    which is only safe to read once the series lock is held).
  for v_series_key in
    select distinct
      p_organization_id::text || '|' || c.inventory_item_id::text || '|' || v_vendor_id::text || '|'
        || coalesce(nullif(upper(btrim(pdl.vendor_sku)), ''), '__NOSKU__') || '|' || v_currency || '|' || upper(btrim(bu.code))
    from public.purchase_document_line_classifications c
    join public.purchase_document_lines pdl
      on pdl.purchase_document_id = p_purchase_document_id and pdl.organization_id = p_organization_id and pdl.line_key = c.line_key
    join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
    join public.units bu on bu.id = ii.base_unit_id
    where c.organization_id = p_organization_id
      and c.purchase_document_id = p_purchase_document_id
      and c.status = 'CONFIRMED' and c.disposition = 'INVENTORY' and c.inventory_item_id is not null
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_series_key, 0));
  end loop;

  -- 4-5. Recompute the comparable baseline + validate acknowledgment on the
  --      now-serialized, locked state.
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
    join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = p_organization_id
    join public.units bu on bu.id = ii.base_unit_id
    left join public.vendor_item_purchase_units vpu on vpu.id = c.vendor_item_purchase_unit_id and vpu.organization_id = p_organization_id
    left join public.units pu on pu.id = vpu.purchase_unit_id
    join public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er on true
    join public.receipt_lines rl on rl.receipt_id = er.id and rl.organization_id = p_organization_id and rl.matched_line_key = c.line_key
    where c.organization_id = p_organization_id
      and c.purchase_document_id = p_purchase_document_id
      and c.status = 'CONFIRMED' and c.disposition = 'INVENTORY' and c.inventory_item_id is not null
    group by c.line_key, c.inventory_item_id, pdl.vendor_sku, bu.code, pdl.line_total
  ),
  priced as (
    select cur.*, case when cur.base_qty > 0 and cur.line_total > 0 then cur.line_total / cur.base_qty else null end as current_unit_cost
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
