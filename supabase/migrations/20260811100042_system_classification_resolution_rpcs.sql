-- Milestone 2A.3 (part 8 of 8): system-path RPCs used by the classification
-- orchestrator itself (app/lib/itemMaster/classifyPurchaseDocumentLines.ts)
-- -- distinct from the manager-facing approve_line_classification_* RPCs in
-- 20260811100041, which require an explicit human decision. These three
-- are called automatically, with no manager involved yet:
--
--   resolve_line_classification_deterministic -- zero-AI-call tier (a
--     confirmed vendor mapping or an exact CONFIRMED-item name match).
--     Writes status='CONFIRMED' directly -- this reapplies a decision a
--     manager has *already* made previously (either by confirming the item
--     itself, or by a prior "remember this mapping" approval), so no new
--     human judgment is being exercised here, but it IS a new authoritative
--     fact about THIS line/document, so it is audited (distinctly from a
--     manual LINE_CLASSIFICATION_CONFIRMED) for full traceability.
--
--   record_ai_suggested_candidate -- AI proposed an EXISTING confirmed item
--     as the match. Writes status='PENDING_REVIEW' -- nothing authoritative
--     yet, so no audit event (mirrors "AI never mutates DB authoritatively").
--
--   record_ai_item_proposal -- AI found no good existing-item match and
--     proposed a brand new item. Creates the PENDING_REVIEW inventory_items
--     row itself (best-effort category/spend-category/base-unit resolution
--     by name/code -- left null on no match, never a hard failure, since a
--     PENDING_REVIEW row structurally requires neither) plus the
--     PENDING_REVIEW classification row pointing at it. No audit event, for
--     the same reason as above -- the manager's later approval is what
--     turns this proposal into fact (ITEM_PROPOSAL_APPROVED).

create or replace function public.resolve_line_classification_deterministic(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_inventory_item_id uuid,
  p_resolution_source text
)
returns table (out_classification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_item record;
  v_classification_id uuid;
begin
  if p_resolution_source not in ('VENDOR_SKU_MAPPING', 'VENDOR_DESCRIPTION_MAPPING', 'NORMALIZED_NAME_MATCH') then
    raise exception 'invalid deterministic resolution_source %', p_resolution_source;
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
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, p_resolution_source, 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = null,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  insert into public.audit_events (organization_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, 'LINE_CLASSIFICATION_AUTO_RESOLVED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item.id, 'resolutionSource', p_resolution_source));

  return query select v_classification_id;
end;
$$;

revoke all on function public.resolve_line_classification_deterministic(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.resolve_line_classification_deterministic(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public.record_ai_suggested_candidate(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_candidate_inventory_item_id uuid,
  p_ai_confidence numeric
)
returns table (out_classification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_item record;
  v_classification_id uuid;
begin
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

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    ai_suggested_inventory_item_id, spend_category_id, ai_confidence, resolution_source, status,
    resolved_against_snapshot, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, p_ai_confidence, 'AI_SUGGESTED', 'PENDING_REVIEW',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = null,
    ai_suggested_inventory_item_id = excluded.ai_suggested_inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    ai_confidence = excluded.ai_confidence,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = null,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  return query select v_classification_id;
end;
$$;

revoke all on function public.record_ai_suggested_candidate(uuid, uuid, uuid, uuid, numeric) from public;
grant execute on function public.record_ai_suggested_candidate(uuid, uuid, uuid, uuid, numeric) to service_role;

create or replace function public.record_ai_item_proposal(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_proposed_name text,
  p_proposed_disposition text,
  p_proposed_category_name text,
  p_proposed_spend_category_name text,
  p_proposed_base_unit_code text,
  p_ai_confidence numeric
)
returns table (out_inventory_item_id uuid, out_classification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_disposition text := coalesce(p_proposed_disposition, 'INVENTORY');
  v_category_id uuid;
  v_spend_category_id uuid;
  v_base_unit_id uuid;
  v_item_id uuid;
  v_classification_id uuid;
begin
  if v_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    v_disposition := 'INVENTORY';
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

  -- Best-effort pre-fill only -- a PENDING_REVIEW row structurally needs
  -- neither category_id, spend_category_id, nor base_unit_id, so a miss
  -- here is never a hard failure; the manager resolves it at approval time.
  if p_proposed_category_name is not null then
    select id into v_category_id
      from public.inventory_categories
     where organization_id = p_organization_id
       and lower(name) = lower(p_proposed_category_name)
     limit 1;
  end if;

  if p_proposed_spend_category_name is not null then
    select id into v_spend_category_id
      from public.spend_categories
     where organization_id = p_organization_id
       and lower(name) = lower(p_proposed_spend_category_name)
     limit 1;
  end if;

  if p_proposed_base_unit_code is not null then
    select id into v_base_unit_id from public.units where code = p_proposed_base_unit_code;
  end if;

  v_item_id := gen_random_uuid();
  insert into public.inventory_items (
    id, organization_id, category_id, name, base_unit_id, status,
    disposition, spend_category_id, approval_status, created_via
  ) values (
    v_item_id, p_organization_id, v_category_id, p_proposed_name, v_base_unit_id, 'active',
    v_disposition, v_spend_category_id, 'PENDING_REVIEW', 'AI_PROPOSED'
  );

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    ai_suggested_inventory_item_id, spend_category_id, ai_confidence, resolution_source, status,
    resolved_against_snapshot, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_disposition,
    v_item_id, v_spend_category_id, p_ai_confidence, 'AI_SUGGESTED', 'PENDING_REVIEW',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = null,
    ai_suggested_inventory_item_id = excluded.ai_suggested_inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    ai_confidence = excluded.ai_confidence,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = null,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.record_ai_item_proposal(uuid, uuid, uuid, text, text, text, text, text, numeric) from public;
grant execute on function public.record_ai_item_proposal(uuid, uuid, uuid, text, text, text, text, text, numeric) to service_role;
