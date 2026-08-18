-- Enables a SAFE re-run of item classification for a line that already has
-- an unconfirmed (PENDING_REVIEW) AI-proposed new item -- needed because
-- 20260811100049's canonical-candidate-id fix only affects classification
-- runs from this point forward; a manager needs a way to refresh an OLDER
-- proposal (created by the previous, brittle free-text-matching classifier)
-- to pick up the corrected resolution, without manually deleting anything.
--
-- Two changes to record_ai_item_proposal, same signature as 20260811100049
-- (a logic-only change, not a signature change, so a bare CREATE OR REPLACE
-- is correct here -- see 20260811100042's own comment on when DROP is vs
-- isn't required):
--
-- 1. Refuses to touch an already-CONFIRMED classification for this line,
--    full stop. Manager-confirmed items must never be silently overwritten,
--    regardless of what calls this RPC or why -- this is enforced here as a
--    backstop, not only trusted to the application layer's own line
--    selection (app/lib/itemMaster/getLinesNeedingClassification.ts).
--
-- 2. When a classification row already exists for this line with
--    status='PENDING_REVIEW' and its ai_suggested_inventory_item_id still
--    points at a live, unconfirmed (approval_status='PENDING_REVIEW',
--    created_via='AI_PROPOSED') pending item, that SAME inventory_items row
--    is updated in place -- never a fresh gen_random_uuid() insert. Without
--    this, every re-run would mint a brand new pending Item Master row and
--    leave the previous one behind as a permanent, un-referenced orphan
--    (never confirmable, never cleaned up).
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

  select status, ai_suggested_inventory_item_id into v_existing_classification
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  if v_existing_classification.status = 'CONFIRMED' then
    raise exception 'line % is already CONFIRMED and cannot be re-proposed', p_line_key
      using errcode = 'GA012';
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
