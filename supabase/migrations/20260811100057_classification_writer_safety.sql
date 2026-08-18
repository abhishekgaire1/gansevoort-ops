-- Adversarial-review fixes, priority 1 + 2 (post-2A.3-review hardening).
-- Fixes two CRITICAL findings against the three SYSTEM classification
-- writers (resolve_line_classification_deterministic,
-- record_ai_suggested_candidate, record_ai_item_proposal), all defined
-- in 20260811100042/20260811100050, left untouched -- this migration
-- CREATE OR REPLACEs the same function names/signatures with corrected
-- bodies only, the established technique already used repeatedly in this
-- migration sequence (e.g. 20260811100056's own body-only replaces).
--
-- Finding #1 (CRITICAL): none of the three ever set
-- gansevoort.purchase_document_ready_write, so 20260811100056's new lock
-- trigger on purchase_document_line_classifications unconditionally
-- rejects every system classification write once a document reaches
-- READY_FOR_VERIFICATION (GA003) -- breaking the plan's own required
-- "auto-reclassify a STALE line after a reviewer correction, without the
-- manager needing to click anything" flow, deterministically, every time.
-- Fixed by having each writer inspect the parent purchase_document's
-- status itself and set the flag ONLY when status is DRAFT or
-- READY_FOR_VERIFICATION -- mirroring the exact pattern already proven
-- correct for purchase_document_lines/purchase_documents. VERIFIED and
-- DISCARDED are never granted the flag, so the lock stays absolute for
-- them regardless of this change -- these RPCs are service_role-only
-- (see their own revoke/grant below, unchanged) and re-verify the status
-- themselves rather than trusting a caller's belief about it.
--
-- Finding #2 (CRITICAL): resolve_line_classification_deterministic and
-- record_ai_suggested_candidate UPSERTed unconditionally, so a
-- classification run racing a manager's manual confirmation of the same
-- line could silently overwrite/erase the manager's CONFIRMED decision
-- (record_ai_suggested_candidate even nulled out inventory_item_id and
-- resolved_by_app_user_id). record_ai_item_proposal already refused this
-- case, but by RAISING (GA012) -- which, given classifyPurchaseDocumentLines
-- .ts's per-line loop has no per-iteration isolation, aborted every OTHER
-- line's already-computed AI result in the same batch too. All three now
-- treat an existing CONFIRMED row identically: preserve it byte-for-byte
-- untouched (no INSERT, no UPDATE, no audit event) and return its existing
-- id as a normal, successful no-op -- "already resolved, nothing to do,"
-- never an error -- so the orchestrator's loop naturally continues to the
-- next line with no try/catch changes required anywhere.
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
  v_parent_status text;
  v_line record;
  v_item record;
  v_existing record;
  v_classification_id uuid;
begin
  if p_resolution_source not in ('VENDOR_SKU_MAPPING', 'VENDOR_DESCRIPTION_MAPPING', 'NORMALIZED_NAME_MATCH') then
    raise exception 'invalid deterministic resolution_source %', p_resolution_source;
  end if;

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
    -- Manager authority already won -- preserve it untouched, report
    -- success (not an error), so the caller's batch keeps moving.
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
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  -- Only now, after every check above has succeeded and we know this is a
  -- genuine, non-overwriting system write against a still-mutable
  -- document, enable the narrow trigger-level capability the parent-table
  -- lock trigger requires.
  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

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

-- record_ai_item_proposal: same parent-status gate added, and the
-- existing "already CONFIRMED" guard (20260811100050) changes from
-- raising GA012 to the same untouched-no-op-return shape as the two
-- functions above, for the same batch-continuation reason. Everything
-- else (pending-item reuse, best-effort category/spend-category/base-unit
-- resolution) is unchanged from 20260811100050.
create or replace function public.record_ai_item_proposal(
  p_organization_id uuid,
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_proposed_name text,
  p_proposed_disposition text,
  p_proposed_category_id uuid,
  p_proposed_spend_category_id uuid,
  p_proposed_base_unit_code text,
  p_ai_confidence numeric,
  p_proposed_vendor_purchase_unit_code text default null,
  p_proposed_receiving_behavior text default null,
  p_proposed_fixed_conversion_factor numeric default null
)
returns table (out_inventory_item_id uuid, out_classification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_status text;
  v_line record;
  v_disposition text := coalesce(p_proposed_disposition, 'INVENTORY');
  v_category_id uuid;
  v_spend_category_id uuid;
  v_base_unit_id uuid;
  v_item_id uuid;
  v_classification_id uuid;
  v_purchase_unit_snapshot jsonb;
  v_existing_classification record;
  v_reusable_pending_item_id uuid;
begin
  if v_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    v_disposition := 'INVENTORY';
  end if;

  if p_proposed_receiving_behavior is not null and p_proposed_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid proposed receiving behavior %', p_proposed_receiving_behavior;
  end if;

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

  select id, status, inventory_item_id, ai_suggested_inventory_item_id into v_existing_classification
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  if v_existing_classification.status = 'CONFIRMED' then
    -- Manager authority already won -- preserve it untouched, report
    -- success (not an error, so the caller's batch keeps moving).
    return query select v_existing_classification.inventory_item_id, v_existing_classification.id;
    return;
  end if;

  if v_existing_classification.ai_suggested_inventory_item_id is not null then
    select id into v_reusable_pending_item_id
      from public.inventory_items
     where id = v_existing_classification.ai_suggested_inventory_item_id
       and organization_id = p_organization_id
       and approval_status = 'PENDING_REVIEW'
       and created_via = 'AI_PROPOSED';
  end if;

  -- Best-effort pre-fill only -- a PENDING_REVIEW row structurally needs
  -- neither category_id, spend_category_id, nor base_unit_id, so a miss
  -- here is never a hard failure; the manager resolves it at approval time.
  -- Direct id lookup, re-validating organization ownership as defense in
  -- depth (the application layer already validated the id against the
  -- exact candidate set it gave the model) -- never a name-based match.
  if p_proposed_category_id is not null then
    select id into v_category_id
      from public.inventory_categories
     where id = p_proposed_category_id
       and organization_id = p_organization_id;
  end if;

  if p_proposed_spend_category_id is not null then
    select id into v_spend_category_id
      from public.spend_categories
     where id = p_proposed_spend_category_id
       and organization_id = p_organization_id;
  end if;

  if p_proposed_base_unit_code is not null then
    select id into v_base_unit_id from public.units where code = p_proposed_base_unit_code;
  end if;

  -- Only stored if it names a real global unit -- same "AI may not
  -- reference something that doesn't exist" principle as base_unit_id
  -- above, just for display/pre-fill rather than a foreign key.
  if p_proposed_vendor_purchase_unit_code is not null and not exists (
    select 1 from public.units where code = p_proposed_vendor_purchase_unit_code
  ) then
    p_proposed_vendor_purchase_unit_code := null;
  end if;

  v_purchase_unit_snapshot := case
    when p_proposed_vendor_purchase_unit_code is not null or p_proposed_receiving_behavior is not null then
      jsonb_build_object(
        'vendorPurchaseUnitCode', p_proposed_vendor_purchase_unit_code,
        'receivingBehavior', p_proposed_receiving_behavior,
        'fixedConversionFactor', p_proposed_fixed_conversion_factor
      )
    else null
  end;

  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  if v_reusable_pending_item_id is not null then
    -- A safe refresh of an existing, still-unconfirmed AI proposal --
    -- update the SAME pending item row rather than minting a duplicate.
    v_item_id := v_reusable_pending_item_id;
    update public.inventory_items
       set category_id = v_category_id,
           name = p_proposed_name,
           base_unit_id = v_base_unit_id,
           disposition = v_disposition,
           spend_category_id = v_spend_category_id
     where id = v_item_id;
  else
    v_item_id := gen_random_uuid();
    insert into public.inventory_items (
      id, organization_id, category_id, name, base_unit_id, status,
      disposition, spend_category_id, approval_status, created_via
    ) values (
      v_item_id, p_organization_id, v_category_id, p_proposed_name, v_base_unit_id, 'active',
      v_disposition, v_spend_category_id, 'PENDING_REVIEW', 'AI_PROPOSED'
    );
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    ai_suggested_inventory_item_id, spend_category_id, ai_confidence, resolution_source, status,
    resolved_against_snapshot, resolved_at, ai_proposed_purchase_unit
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_disposition,
    v_item_id, v_spend_category_id, p_ai_confidence, 'AI_SUGGESTED', 'PENDING_REVIEW',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    now(), v_purchase_unit_snapshot
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
    resolved_at = excluded.resolved_at,
    ai_proposed_purchase_unit = excluded.ai_proposed_purchase_unit
  returning id into v_classification_id;

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.record_ai_item_proposal(uuid, uuid, uuid, text, text, uuid, uuid, text, numeric, text, text, numeric) from public;
grant execute on function public.record_ai_item_proposal(uuid, uuid, uuid, text, text, uuid, uuid, text, numeric, text, text, numeric) to service_role;
