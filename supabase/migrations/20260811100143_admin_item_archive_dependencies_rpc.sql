-- Safe editing of confirmed items with inventory-impact protection (Part 8).
--
-- Archive dependency visibility (spec section 11): set_admin_item_status
-- (20260811100098) already hard-blocks deactivation while positive stock
-- exists anywhere (GA050) -- that guarantee is untouched. This adds the
-- read-only visibility the spec also asks for: active vendor mappings,
-- active kiosk usage units, and open (unposted) purchase-document lines
-- referencing the item, none of which set_admin_item_status has ever
-- checked. These are surfaced as INFORMATION for the manager to
-- acknowledge before confirming Archive, not additional hard DB-level
-- blocks -- archiving an item with a stale vendor mapping or an open
-- draft referencing it is an operational cleanliness concern, not an
-- inventory-safety one (the item stays fully intact and reactivatable;
-- nothing about its historical correctness changes).
create function public.get_admin_item_archive_dependencies(
  p_organization_id uuid,
  p_item_id uuid
) returns table (
  out_has_positive_stock boolean,
  out_positive_stock_locations jsonb,
  out_active_vendor_mapping_count integer,
  out_active_usage_unit_count integer,
  out_open_document_line_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with stock as (
    select b.out_location_id, b.out_balance, l.name as location_name
      from public.inventory_location_balances(p_organization_id) b
      join public.locations l on l.id = b.out_location_id
     where b.out_inventory_item_id = p_item_id and b.out_balance > 0
  ),
  vendor_mappings as (
    select count(*) as cnt
      from public.vendor_item_mappings
     where organization_id = p_organization_id
       and inventory_item_id = p_item_id
       and is_active
  ),
  usage_units as (
    select count(*) as cnt
      from public.inventory_item_usage_units
     where organization_id = p_organization_id
       and inventory_item_id = p_item_id
       and usage_slot = 2
       and is_active
  ),
  open_lines as (
    select count(*) as cnt
      from public.purchase_document_line_classifications c
      join public.purchase_documents pd
        on pd.id = c.purchase_document_id and pd.organization_id = c.organization_id
     where c.organization_id = p_organization_id
       and c.inventory_item_id = p_item_id
       and c.status in ('PENDING_REVIEW', 'CONFIRMED')
       and pd.status in ('DRAFT', 'READY_FOR_VERIFICATION')
  )
  select
    exists (select 1 from stock),
    coalesce((select jsonb_agg(jsonb_build_object('locationId', out_location_id, 'locationName', location_name, 'balance', out_balance)) from stock), '[]'::jsonb),
    (select cnt from vendor_mappings)::integer,
    (select cnt from usage_units)::integer,
    (select cnt from open_lines)::integer;
$$;

revoke all on function public.get_admin_item_archive_dependencies(uuid, uuid) from public;
grant execute on function public.get_admin_item_archive_dependencies(uuid, uuid) to service_role;
