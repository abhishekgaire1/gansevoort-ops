-- Milestone 2A.3 (part 7 of 8): manager-facing RPCs for item approval,
-- vendor-mapping confirmation, delivery-verifier correction, and
-- receiving.
--
-- App-defined SQLSTATE registry continues from the existing GA001-GA006
-- (app/lib/purchaseDocuments/errors.ts) and GA007/GA008 (this milestone's
-- earlier migrations -- spend-category cycle, inactive/missing employee):
--   GA009 ITEM_NOT_PENDING_REVIEW  -- approve/reject called on a non-pending item
--   GA010 ITEM_PROPOSAL_REFERENCED -- reject attempted on an item still referenced
--   GA011 LINE_NOT_FOUND_IN_CURRENT_REVISION
--   GA012 RECEIPT_NOT_FOUND_OR_INVALID
--
-- New-item approval and existing-item approval are each ONE manager
-- action/one RPC call, not several sequential confirms: item confirmation
-- (if new), line-classification confirmation, and optional vendor-mapping
-- memory all happen in the same transaction.

-- Shared upsert-with-remap helper used by both approve RPCs below: writes
-- a confirmed vendor_item_mappings row for (vendor, match_basis, key
-- value), remapping safely if an active mapping already points somewhere
-- else -- never a raw INSERT that could collide with the partial unique
-- index the instant a vendor's SKU/description has been mapped before.
-- A no-op if the existing active mapping already points at the same item
-- (avoids a pointless deactivate-then-reinsert churn on every repeat
-- confirmation of an already-correct mapping).
create or replace function public.upsert_vendor_item_mapping(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_match_basis text,
  p_vendor_sku text,
  p_normalized_description text,
  p_inventory_item_id uuid,
  p_confirmed_by_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_id uuid;
  v_existing_item_id uuid;
  v_had_existing boolean;
  v_new_id uuid;
begin
  select id, inventory_item_id into v_existing_id, v_existing_item_id
    from public.vendor_item_mappings
   where organization_id = p_organization_id
     and vendor_id = p_vendor_id
     and match_basis = p_match_basis
     and is_active
     and (p_match_basis <> 'VENDOR_SKU' or vendor_sku = p_vendor_sku)
     and (p_match_basis <> 'NORMALIZED_DESCRIPTION' or normalized_description = p_normalized_description);
  -- Captured immediately: FOUND is overwritten by every subsequent
  -- statement (including the INSERT below, which always sets it true),
  -- so it cannot be relied on again later in this function.
  v_had_existing := found;

  if v_had_existing and v_existing_item_id = p_inventory_item_id then
    -- Already correctly mapped -- nothing to do.
    return;
  end if;

  v_new_id := gen_random_uuid();

  if v_had_existing then
    update public.vendor_item_mappings
       set is_active = false, superseded_by_mapping_id = v_new_id
     where id = v_existing_id;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_organization_id, p_confirmed_by_app_user_id, 'VENDOR_ITEM_MAPPING_REMAPPED', 'vendor_item_mapping', v_new_id,
      jsonb_build_object('inventoryItemId', v_existing_item_id), jsonb_build_object('inventoryItemId', p_inventory_item_id));
  end if;

  insert into public.vendor_item_mappings (
    id, organization_id, vendor_id, match_basis, vendor_sku, normalized_description, inventory_item_id, confirmed_by_app_user_id
  ) values (
    v_new_id, p_organization_id, p_vendor_id, p_match_basis, p_vendor_sku, p_normalized_description, p_inventory_item_id, p_confirmed_by_app_user_id
  );

  if not v_had_existing then
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_confirmed_by_app_user_id, 'VENDOR_ITEM_MAPPING_CONFIRMED', 'vendor_item_mapping', v_new_id,
      jsonb_build_object('inventoryItemId', p_inventory_item_id));
  end if;
end;
$$;

revoke all on function public.upsert_vendor_item_mapping(uuid, uuid, text, text, text, uuid, uuid) from public;
grant execute on function public.upsert_vendor_item_mapping(uuid, uuid, text, text, text, uuid, uuid) to service_role;

create or replace function public.approve_line_classification_new_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_final_name text,
  p_disposition text,
  p_category_id uuid,
  p_spend_category_id uuid,
  p_base_unit_code text,
  p_pending_item_id uuid default null,
  p_remember_vendor_mapping boolean default true
)
returns table (
  out_inventory_item_id uuid,
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_base_unit_id uuid;
  v_line record;
  v_classification_id uuid;
  v_vendor_id uuid;
begin
  if p_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid disposition %', p_disposition;
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

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if p_disposition = 'INVENTORY' then
    select id into v_base_unit_id from public.units where code = p_base_unit_code;
    if v_base_unit_id is null then
      raise exception 'unknown unit code %', p_base_unit_code;
    end if;
  end if;

  if p_pending_item_id is not null then
    -- AI already proposed this item -- confirm THAT row (with the
    -- manager's possibly-edited final values), never create a duplicate.
    update public.inventory_items as ii
       set name = p_final_name,
           disposition = p_disposition,
           category_id = case when p_disposition = 'INVENTORY' then p_category_id else null end,
           spend_category_id = p_spend_category_id,
           base_unit_id = v_base_unit_id,
           approval_status = 'CONFIRMED'
     where ii.id = p_pending_item_id
       and ii.organization_id = p_organization_id
       and ii.approval_status = 'PENDING_REVIEW'
     returning ii.id into v_item_id;

    if not found then
      raise exception 'inventory_item % is not a pending proposal', p_pending_item_id
        using errcode = 'GA009';
    end if;
  else
    v_item_id := gen_random_uuid();
    insert into public.inventory_items (
      id, organization_id, category_id, name, base_unit_id, status,
      disposition, spend_category_id, approval_status, created_via
    ) values (
      v_item_id, p_organization_id,
      case when p_disposition = 'INVENTORY' then p_category_id else null end,
      p_final_name, v_base_unit_id, 'active',
      p_disposition, p_spend_category_id, 'CONFIRMED', 'MANUAL'
    );
  end if;

  -- Self-referencing base-unit row -- INVENTORY disposition only, only at
  -- confirmation time. A PENDING_REVIEW item never has one (see
  -- 20260811100035's comment on why that structurally blocks withdrawal).
  if p_disposition = 'INVENTORY' and not exists (
    select 1 from public.inventory_item_units where inventory_item_id = v_item_id and unit_id = v_base_unit_id
  ) then
    insert into public.inventory_item_units (
      inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
    ) values (
      v_item_id, v_base_unit_id, 1, false, true, true
    );
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, p_disposition,
    v_item_id, p_spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  if p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id
      );
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_APPROVED', 'inventory_item', v_item_id,
    jsonb_build_object('name', p_final_name, 'disposition', p_disposition));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item_id, 'newItem', true));

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean
) from public;
grant execute on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean
) to service_role;

create or replace function public.approve_line_classification_existing_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_remember_vendor_mapping boolean default true
)
returns table (
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_item record;
  v_vendor_id uuid;
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
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  if p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id
      );
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item.id, p_app_user_id
      );
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item.id, 'newItem', false));

  return query select v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean) from public;
grant execute on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean) to service_role;

-- Only for high-confidence AI matches to an EXISTING confirmed item --
-- never offered for new-item proposals. Vendor-mapping memory is
-- deliberately not written in bulk (a manager wanting that remembered can
-- confirm individually) -- keeps the bulk path minimal and fast.
create or replace function public.bulk_confirm_line_classifications(
  p_classification_ids uuid[],
  p_organization_id uuid,
  p_app_user_id uuid
)
returns table (
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select c.id, c.purchase_document_id, c.line_key, c.ai_suggested_inventory_item_id
      from public.purchase_document_line_classifications c
     where c.id = any(p_classification_ids)
       and c.organization_id = p_organization_id
       and c.status = 'PENDING_REVIEW'
       and c.resolution_source = 'AI_SUGGESTED'
       and c.ai_suggested_inventory_item_id is not null
  loop
    update public.purchase_document_line_classifications
       set inventory_item_id = v_row.ai_suggested_inventory_item_id,
           status = 'CONFIRMED',
           resolution_source = 'MANUAL',
           resolved_by_app_user_id = p_app_user_id,
           resolved_at = now()
     where id = v_row.id;

    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', v_row.purchase_document_id,
      jsonb_build_object('lineKey', v_row.line_key, 'inventoryItemId', v_row.ai_suggested_inventory_item_id, 'newItem', false, 'bulk', true));

    out_classification_id := v_row.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.bulk_confirm_line_classifications(uuid[], uuid, uuid) from public;
grant execute on function public.bulk_confirm_line_classifications(uuid[], uuid, uuid) to service_role;

create or replace function public.reject_item_proposal(
  p_inventory_item_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inventory_items%rowtype;
begin
  select * into v_item
    from public.inventory_items
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'PENDING_REVIEW';

  if not found then
    raise exception 'inventory_item % is not a pending proposal', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  if exists (select 1 from public.purchase_document_line_classifications where inventory_item_id = p_inventory_item_id) then
    raise exception 'inventory_item % is referenced by a line classification and cannot be rejected -- reassign that line first', p_inventory_item_id
      using errcode = 'GA010';
  end if;

  if exists (select 1 from public.vendor_item_mappings where inventory_item_id = p_inventory_item_id) then
    raise exception 'inventory_item % is referenced by a vendor mapping and cannot be rejected', p_inventory_item_id
      using errcode = 'GA010';
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_REJECTED', 'inventory_item', p_inventory_item_id,
    to_jsonb(v_item), jsonb_build_object('reason', p_reason));

  delete from public.inventory_items where id = p_inventory_item_id and organization_id = p_organization_id;
end;
$$;

revoke all on function public.reject_item_proposal(uuid, uuid, uuid, text) from public;
grant execute on function public.reject_item_proposal(uuid, uuid, uuid, text) to service_role;

create or replace function public.correct_document_delivery_verifier(
  p_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_new_employee_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous uuid;
begin
  if not exists (select 1 from public.documents where id = p_document_id and organization_id = p_organization_id) then
    raise exception 'document % not found', p_document_id;
  end if;

  if not exists (
    select 1 from public.employees e
     where e.id = p_new_employee_id and e.organization_id = p_organization_id and e.status = 'active'
  ) then
    raise exception 'employee % is not an active employee in organization %', p_new_employee_id, p_organization_id
      using errcode = 'GA008';
  end if;

  v_previous := public.current_document_delivery_verifier_employee_id(p_document_id, p_organization_id);

  insert into public.document_delivery_verifier_corrections (
    organization_id, document_id, previous_employee_id, corrected_employee_id, corrected_by_app_user_id, reason
  ) values (
    p_organization_id, p_document_id, v_previous, p_new_employee_id, p_app_user_id, p_reason
  );

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, before_state, after_state)
  values (p_organization_id, p_app_user_id, 'DOCUMENT_DELIVERY_VERIFIER_CORRECTED', 'document', p_document_id,
    jsonb_build_object('employeeId', v_previous), jsonb_build_object('employeeId', p_new_employee_id, 'reason', p_reason));
end;
$$;

revoke all on function public.correct_document_delivery_verifier(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.correct_document_delivery_verifier(uuid, uuid, uuid, uuid, text) to service_role;

-- record_receipt: for a CORRECTION, purchase_document_id is ALWAYS
-- server-derived from the corrected receipt's own row -- never accepted
-- as an independent, trusted client parameter for that case (the
-- composite FK on receipts.corrects_receipt_id makes this doubly safe,
-- but the RPC never even attempts to pass a mismatched value). For a
-- DELIVERY, purchase_document_id is taken from the caller, since a fresh
-- delivery has no prior receipt to derive it from.
create or replace function public.record_receipt(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_receipt_kind text,
  p_purchase_document_id uuid default null,
  p_corrects_receipt_id uuid default null,
  p_default_location_id uuid default null,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb
)
returns table (
  out_receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_effective_pd_id uuid;
  v_source_document_id uuid;
  v_verifier uuid;
begin
  if p_receipt_kind not in ('DELIVERY', 'CORRECTION') then
    raise exception 'invalid receipt_kind %', p_receipt_kind;
  end if;

  if p_receipt_kind = 'CORRECTION' then
    if p_corrects_receipt_id is null then
      raise exception 'corrects_receipt_id is required for a CORRECTION receipt';
    end if;

    select purchase_document_id into v_effective_pd_id
      from public.receipts
     where id = p_corrects_receipt_id and organization_id = p_organization_id;

    if not found then
      raise exception 'receipt % not found', p_corrects_receipt_id
        using errcode = 'GA012';
    end if;
  else
    if p_purchase_document_id is null then
      raise exception 'purchase_document_id is required for a DELIVERY receipt';
    end if;

    if not exists (select 1 from public.purchase_documents where id = p_purchase_document_id and organization_id = p_organization_id) then
      raise exception 'purchase_document % not found', p_purchase_document_id
        using errcode = 'GA012';
    end if;

    v_effective_pd_id := p_purchase_document_id;
  end if;

  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = v_effective_pd_id;

  v_verifier := public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id);

  v_receipt_id := gen_random_uuid();
  insert into public.receipts (
    id, organization_id, purchase_document_id, receipt_kind, corrects_receipt_id,
    default_location_id, delivery_verified_by_employee_id_snapshot, recorded_by_app_user_id, notes
  ) values (
    v_receipt_id, p_organization_id, v_effective_pd_id, p_receipt_kind, p_corrects_receipt_id,
    p_default_location_id, v_verifier, p_app_user_id, p_notes
  );

  insert into public.receipt_lines (
    id, receipt_id, organization_id, line_number_snapshot, matched_line_key,
    vendor_sku_snapshot, description_snapshot,
    invoice_package_quantity, invoice_package_unit, invoice_measured_quantity, invoice_measured_unit,
    actual_received_package_quantity, actual_received_package_unit,
    actual_verified_base_quantity, actual_verified_base_unit_id,
    location_id, condition_status, notes
  )
  select
    gen_random_uuid(), v_receipt_id, p_organization_id,
    (line.value ->> 'lineNumberSnapshot')::integer,
    (line.value ->> 'matchedLineKey')::uuid,
    line.value ->> 'vendorSkuSnapshot', line.value ->> 'descriptionSnapshot',
    (line.value ->> 'invoicePackageQuantity')::numeric, line.value ->> 'invoicePackageUnit',
    (line.value ->> 'invoiceMeasuredQuantity')::numeric, line.value ->> 'invoiceMeasuredUnit',
    (line.value ->> 'actualReceivedPackageQuantity')::numeric, line.value ->> 'actualReceivedPackageUnit',
    (line.value ->> 'actualVerifiedBaseQuantity')::numeric, (line.value ->> 'actualVerifiedBaseUnitId')::uuid,
    (line.value ->> 'locationId')::uuid,
    coalesce(line.value ->> 'conditionStatus', 'RECEIVED_AS_INVOICED'),
    line.value ->> 'notes'
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'RECEIPT_RECORDED', 'purchase_document', v_effective_pd_id,
    jsonb_build_object(
      'receiptId', v_receipt_id, 'receiptKind', p_receipt_kind, 'correctsReceiptId', p_corrects_receipt_id,
      'deliveryVerifiedByEmployeeId', v_verifier
    ));

  return query select v_receipt_id;
end;
$$;

revoke all on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) from public;
grant execute on function public.record_receipt(uuid, uuid, text, uuid, uuid, uuid, text, jsonb) to service_role;
