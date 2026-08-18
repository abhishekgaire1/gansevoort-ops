-- Fixes a real accuracy gap surfaced against a live Gansevoort DEV invoice
-- line: record_ai_item_proposal (20260811100042, extended 20260811100044)
-- resolved category_id/spend_category_id by exact case-insensitive NAME
-- match against the AI's own free-text guess. That is too brittle -- e.g.
-- the AI proposing "Dairy" against a canonical "Dairy & Eggs" category
-- leaves category_id/spend_category_id null even though the correct
-- canonical category obviously exists. The application layer now supplies
-- Gemini the organization's own ACTIVE category candidates (id + name/path)
-- and asks it to select an id directly (see
-- app/lib/ai/tasks/itemClassification/instructions.ts,
-- buildClassificationCandidateContext.ts), independently re-validated
-- against that same candidate set in validate.ts before ever reaching this
-- RPC. This migration is the corresponding DB-side change: the two
-- free-text name params are replaced with direct id params.
--
-- Same technique as 20260811100044's own header comment: the OLD 12-param
-- text-name signature must be DROPped first, not left alongside a new one
-- via a bare CREATE OR REPLACE (that would recreate the exact ambiguous-
-- overload bug fixed in 20260811100043 for finalize_document_upload).
drop function if exists public.record_ai_item_proposal(uuid, uuid, uuid, text, text, text, text, text, numeric, text, text, numeric);

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
