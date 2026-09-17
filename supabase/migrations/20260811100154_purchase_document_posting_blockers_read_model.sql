-- Read-only preview of the inventory-posting blocker scan.
--
-- WHY: post_purchase_document_inventory (20260811100132) enforces, at
-- actual post time, that every unposted effective inventory line is
-- postable -- checking the RECEIVED unit against the line's confirmed
-- purchase package (or the item's base unit fallback). The review UI's
-- own per-line readiness was computed separately in TypeScript from the
-- INVOICE unit, so a line whose invoice unit was blank/unrecognized (but
-- whose received unit differs from the base unit) passed "Ready" in the
-- review step and only failed at posting -- e.g. a sour-cream line
-- received in PACK against a base unit of LB with no confirmed package.
--
-- THE FIX: expose the SAME scan as a read-only function so the review
-- step and the sole-approver preview can show exactly what posting will
-- refuse, before submission. This function's inner SELECT is kept
-- byte-identical to the enforcement scan in
-- post_purchase_document_inventory (20260811100132) -- they MUST stay in
-- lockstep; a parity test (in soleApproverPermission.rpc.test.ts) asserts
-- the read model flags the same line the enforcement scan refuses. Read-
-- only: it never posts, never raises GA017, just
-- returns the blocked lines (empty when the document is fully postable).

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
