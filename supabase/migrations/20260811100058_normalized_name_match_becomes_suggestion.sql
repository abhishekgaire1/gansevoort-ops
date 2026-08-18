-- Adversarial-review fix, priority 8.
--
-- resolveDeterministicClassification's tier 3 (NORMALIZED_NAME_MATCH) --
-- an exact, case-insensitive match against ANY CONFIRMED Item Master
-- entry's name, org-wide, with no vendor scoping at all -- was being
-- routed through resolve_line_classification_deterministic, which writes
-- status='CONFIRMED' immediately: zero human review, zero AI second look.
-- Two different vendors invoicing a generically-named line (e.g. "Chicken
-- Breast") could silently auto-confirm to the same, possibly wrong, Item
-- Master row before anyone looked at it.
--
-- Tiers 1/2 (VENDOR_SKU_MAPPING, VENDOR_DESCRIPTION_MAPPING) are unchanged
-- -- those really are a manager's own prior, vendor-scoped confirmation
-- being reapplied, and stay deterministic-CONFIRMED via
-- resolve_line_classification_deterministic exactly as before.
--
-- This migration adds ONE new, narrow function --
-- record_deterministic_suggested_candidate -- for tier 3 only: writes
-- status='PENDING_REVIEW' with resolution_source='NORMALIZED_NAME_MATCH'
-- (never 'AI_SUGGESTED', so the manager's own item-mapping panel can
-- still tell the two apart if it wants to), pointing at the matched
-- candidate item, requiring the same explicit manager confirmation as any
-- AI-suggested candidate. A new function rather than widening
-- record_ai_suggested_candidate's signature -- avoids any risk of
-- changing that already-tested function's existing behavior/signature for
-- its real callers. Carries the exact same DRAFT/READY_FOR_VERIFICATION
-- parent-status gate and CONFIRMED-preservation no-op as every other
-- system classification writer (20260811100057).
create or replace function public.record_deterministic_suggested_candidate(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_candidate_inventory_item_id uuid
)
returns table (out_classification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_status text;
  v_line record;
  v_item record;
  v_existing record;
  v_classification_id uuid;
begin
  select status into v_parent_status
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if v_parent_status is null then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_parent_status not in ('DRAFT', 'READY_FOR_VERIFICATION') then
    raise exception 'purchase_document % is % and cannot accept a system classification write', p_purchase_document_id, v_parent_status
      using errcode = 'GA003';
  end if;

  select id, status into v_existing
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  if v_existing.status = 'CONFIRMED' then
    return query select v_existing.id;
    return;
  end if;

  select vendor_sku, description, package_unit, measured_unit
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;

  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  select id, disposition, spend_category_id into v_item
    from public.inventory_items
   where id = p_candidate_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_candidate_inventory_item_id
      using errcode = 'GA009';
  end if;

  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    ai_suggested_inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, 'NORMALIZED_NAME_MATCH', 'PENDING_REVIEW',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = null,
    ai_suggested_inventory_item_id = excluded.ai_suggested_inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = null,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  return query select v_classification_id;
end;
$$;

revoke all on function public.record_deterministic_suggested_candidate(uuid, uuid, uuid, uuid) from public;
grant execute on function public.record_deterministic_suggested_candidate(uuid, uuid, uuid, uuid) to service_role;
