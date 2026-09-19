-- Revert 20260811100169's change to get_purchase_document_posting_blockers.
--
-- 100169 folded the posting-time price-review determination into the blockers
-- read model. Investigation of the real Bartlett #3776989 failure showed the
-- guard's price recompute SUMS receipt lines across every effective receipt,
-- so a document that recorded the SAME delivery more than once (duplicate
-- DELIVERY receipts) triple-counts its received quantity and produces a false
-- "significant price change" on every line. Surfacing that (buggy) signal as a
-- posting blocker mislabels a duplicate-delivery data problem as a price change
-- in Step 2. The real condition is now detected directly (duplicate-delivery
-- readiness blocker in getPreparationStatus and the sole-approver action), so
-- restore the original blockers read model and drop the price-review helper.
--
-- Body reproduced verbatim from 20260811100154.

drop function if exists public.get_purchase_document_price_review_lines(uuid, uuid);

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
  where b.reason is not null;
$$;

revoke all on function public.get_purchase_document_posting_blockers(uuid, uuid) from public;
grant execute on function public.get_purchase_document_posting_blockers(uuid, uuid) to service_role;
