-- Make Step-2/Step-3 readiness agree with the posting-time price-review guard.
--
-- Root cause of the "We couldn't post this invoice" failure on a document
-- whose lines all showed Ready: the BEFORE-INSERT posting guard
-- (assert_price_review_acknowledged) correctly raises GA079 for an
-- unacknowledged significant price change, but the readiness read model
-- get_purchase_document_posting_blockers (20260811100154, written before the
-- price-review feature) never checked for it -- so the UI declared the invoice
-- ready and offered "Post to Inventory", then the post failed at the guard.
--
-- Fix (no weakening of any validation): expose the guard's EXACT per-line
-- determination as one shared read model, and consume it in the blockers read
-- model so the UI shows the blocker, Step 3 disables Post Now, and posting
-- still independently enforces the same rule. The app also reads the same
-- current_unit_cost, so an acknowledgment persists the value the guard matches
-- on (round(current_unit_cost, 6)) and therefore actually clears GA079.
--
-- The recompute below is copied verbatim from the guard (20260811100167): the
-- behavior-aware base quantity (measured -> verified; same-unit -> received;
-- fixed -> received x factor), the get_comparable_price_baseline lateral, the
-- >= 20% threshold, and the numeric acknowledgment match. Keeping ONE source
-- for both the guard and the read models is what guarantees they never drift.

create or replace function public.get_purchase_document_price_review_lines(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns table (
  out_line_key uuid,
  out_inventory_item_id uuid,
  out_vendor_sku text,
  out_currency text,
  out_current_unit_cost numeric,
  out_prev_purchase_document_id uuid,
  out_prev_unit_cost numeric,
  out_delta_pct numeric,
  out_requires_ack boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with doc as (
    select public.normalize_currency_code(currency) as currency, document_date as before_date, vendor_id
      from public.purchase_documents
     where id = p_purchase_document_id and organization_id = p_organization_id
  ),
  cur as (
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
      p_organization_id, (select vendor_id from doc), priced.inventory_item_id, priced.vendor_sku,
      (select currency from doc), priced.base_unit_code, (select before_date from doc), p_purchase_document_id
    ) b on true
    where priced.current_unit_cost is not null and (select currency from doc) is not null
  )
  select
    compared.line_key,
    compared.inventory_item_id,
    compared.vendor_sku,
    (select currency from doc),
    compared.current_unit_cost,
    compared.prev_pd,
    compared.prev_unit_cost,
    compared.delta_pct,
    (
      compared.delta_pct is not null and compared.delta_pct >= 20
      and not exists (
        select 1 from public.price_change_acknowledgments a
         where a.organization_id = p_organization_id
           and a.purchase_document_id = p_purchase_document_id
           and a.line_key = compared.line_key
           and a.inventory_item_id = compared.inventory_item_id
           and a.vendor_id = (select vendor_id from doc)
           and public.normalize_currency_code(a.currency) is not distinct from (select currency from doc)
           and upper(btrim(coalesce(a.vendor_sku, ''))) = upper(btrim(coalesce(compared.vendor_sku, '')))
           and a.previous_purchase_document_id is not distinct from compared.prev_pd
           and round(a.previous_unit_cost, 6) = round(compared.prev_unit_cost, 6)
           and round(a.current_unit_cost, 6) = round(compared.current_unit_cost, 6)
      )
    ) as requires_ack
  from compared;
$$;

revoke all on function public.get_purchase_document_price_review_lines(uuid, uuid) from public;
grant execute on function public.get_purchase_document_price_review_lines(uuid, uuid) to service_role;

-- Blockers read model now also reports the price-review-acknowledgment
-- requirement (same source as the guard). Original body reproduced verbatim
-- from 20260811100154 with the price-review UNION appended.
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
  ) b
  where b.reason is not null

  union all

  -- Price-review acknowledgment: a significant, comparable change that has not
  -- been (re-)acknowledged. Same determination the posting guard enforces.
  select prl.out_line_key,
         coalesce(pdl.description, 'Line'),
         'this invoice has a significant price change that must be reviewed again before posting'
    from public.get_purchase_document_price_review_lines(p_purchase_document_id, p_organization_id) prl
    left join public.purchase_document_lines pdl
      on pdl.purchase_document_id = p_purchase_document_id
     and pdl.organization_id = p_organization_id
     and pdl.line_key = prl.out_line_key
   where prl.out_requires_ack;
$$;

revoke all on function public.get_purchase_document_posting_blockers(uuid, uuid) from public;
grant execute on function public.get_purchase_document_posting_blockers(uuid, uuid) to service_role;
