-- Item-matching robustness fix, reproduced against a real invoice (Capital
-- Paper Inc #178606): two DIFFERENT lines on one document -- a normal
-- purchase line and a separate credit/return line for the same physical
-- product -- can both legitimately get AI-proposed as the same brand-new
-- item name (e.g. "Black Dome Lid for Hot Cup") when no confirmed Item
-- Master entry exists for it yet. record_ai_item_proposal's existing
-- "reuse an already-proposed pending item" check (20260811100050) only
-- looks at THIS SAME line's own prior classification -- it has no way to
-- know a SIBLING line in the same batch just created a PENDING_REVIEW item
-- with the identical (case-insensitive) name moments earlier. Whichever of
-- the two lines is processed first succeeds; the second's plain INSERT
-- hits inventory_items_org_lower_name_key (20260811100004) and raises a
-- raw, unmapped unique_violation straight out of this function.
--
-- classifyPurchaseDocumentLines.ts's per-result-line loop has no
-- per-iteration isolation (a separate, orchestration-level fix), so this
-- single exception was aborting persistence of every OTHER line processed
-- after it in that batch -- even though the AI call itself succeeded and
-- most lines had already resolved. This migration fixes the root cause at
-- the data layer: catch the unique_violation on the new-item INSERT and
-- reuse whatever item now carries that name, exactly the same
-- non-destructive "already resolved, attach to it" pattern this function
-- already uses for its own line's history, rather than ever letting a
-- second, colliding new-item proposal reach the caller as an error.
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
    begin
      insert into public.inventory_items (
        id, organization_id, category_id, name, base_unit_id, status,
        disposition, spend_category_id, approval_status, created_via
      ) values (
        v_item_id, p_organization_id, v_category_id, p_proposed_name, v_base_unit_id, 'active',
        v_disposition, v_spend_category_id, 'PENDING_REVIEW', 'AI_PROPOSED'
      );
    exception when unique_violation then
      -- A sibling line in this same batch (most commonly a purchase line
      -- and a separate credit/return line for the identical physical
      -- product) already proposed a new item under this exact
      -- case-insensitive name moments ago. Reuse whatever item now holds
      -- that name instead of raising -- an unmapped constraint violation
      -- here would otherwise propagate out of classifyPurchaseDocumentLines
      -- .ts's per-line result loop and abort every other line's already-
      -- successful result in the same run.
      select id into v_item_id
        from public.inventory_items
       where organization_id = p_organization_id
         and lower(name) = lower(p_proposed_name);

      if not found then
        -- The violation implies a matching row exists; if it's somehow
        -- gone by the time we look, this is a genuinely unexplained state
        -- worth surfacing rather than silently swallowing.
        raise;
      end if;
    end;
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
