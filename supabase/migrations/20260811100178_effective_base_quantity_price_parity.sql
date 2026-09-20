-- Price/posting quantity PARITY: one shared base-quantity definition, derived
-- from the CONTRIBUTING delivery receipts (supersession + delivery_event_id +
-- valid resolution's duplicate exclusions), consumed by BOTH the price guard
-- (GA079) and the TypeScript price comparison -- the same set posting uses
-- (20260811100175). A duplicate/superseded/stale/non-contributing receipt can
-- no longer inflate the normalized unit price for any behavior (same-unit,
-- fixed conversion, or measured-at-receiving).

create or replace function public.purchase_document_effective_base_quantity(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns table (
  out_line_key uuid,
  out_inventory_item_id uuid,
  out_vendor_sku text,
  out_base_unit_code text,
  out_line_total numeric,
  out_base_qty numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.line_key,
    c.inventory_item_id,
    pdl.vendor_sku,
    bu.code,
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
    and rl.receipt_id in (select out_receipt_id from public.purchase_document_effective_delivery_receipts(p_purchase_document_id, p_organization_id))
  where c.organization_id = p_organization_id
    and c.purchase_document_id = p_purchase_document_id
    and c.status = 'CONFIRMED' and c.disposition = 'INVENTORY' and c.inventory_item_id is not null
  group by c.line_key, c.inventory_item_id, pdl.vendor_sku, bu.code, pdl.line_total;
$$;

revoke all on function public.purchase_document_effective_base_quantity(uuid, uuid) from public;
grant execute on function public.purchase_document_effective_base_quantity(uuid, uuid) to service_role;

-- Guard (GA079) reproduced from 20260811100167 with ONLY the inline behavior-
-- aware `cur` CTE replaced by the shared function above (contributing receipts).
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
    select out_line_key as line_key, out_inventory_item_id as inventory_item_id, out_vendor_sku as vendor_sku,
           out_base_unit_code as base_unit_code, out_line_total as line_total, out_base_qty as base_qty
      from public.purchase_document_effective_base_quantity(p_purchase_document_id, p_organization_id)
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

revoke all on function public.assert_price_review_acknowledged(uuid, uuid) from public;
grant execute on function public.assert_price_review_acknowledged(uuid, uuid) to service_role;
