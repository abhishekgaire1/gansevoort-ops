-- Authorized-manager correction of any Step-2 draft (not only the preparer).
--
-- Business requirement: a manager handling "Confirm Items & Receiving" must be
-- able to correct AI mistakes on a purchase-document DRAFT even when they did
-- not create it. Previously only the two item-classification approval RPCs
-- enforced preparer-only (GA006 / NOT_PREPARER); this relaxes THAT guard for
-- holders of a new capability, following the exact has_permission pattern the
-- sole-approver work established (20260811100133 / ...100153):
--
--   * add a grantable permission 'purchase_documents.correct_any_draft';
--   * grant it to the base 'manager' and 'admin' roles (every manager gets it),
--     leaving room to confer it on a future non-manager identity via a role;
--   * change the DRAFT preparer guard in approve_line_classification_new_item
--     and approve_line_classification_existing_item from "must be the preparer"
--     to "must be the preparer OR hold the permission".
--
-- Preserved unchanged: organization isolation (has_permission is org-scoped and
-- every guard still filters by organization_id); the READY_FOR_VERIFICATION
-- reviewer separation (GA004 self-review, GA003 promotion-only) which is a
-- different guard; kiosk employees and unrelated roles (they hold no such
-- role_permission); and the acting manager is still recorded via
-- p_app_user_id in each function's existing audit_events write.
--
-- The two function bodies below are reproduced verbatim from their current
-- definitions (100126 / 100124) with ONLY the DRAFT guard condition extended,
-- so no other behavior changes.

-- The permissions table's unique index is on lower(key) (a functional index),
-- so the conflict target must be the same expression.
insert into public.permissions (key, description)
values ('purchase_documents.correct_any_draft', 'Correct any purchase-document draft in Step 2 (Items & Receiving), not only drafts the manager prepared.')
on conflict (lower(key)) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.name in ('manager', 'admin')
   and p.key = 'purchase_documents.correct_any_draft'
on conflict (role_id, permission_id) do nothing;

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
  p_remember_vendor_mapping boolean default true,
  p_purchase_unit_code text default null,
  p_receiving_behavior text default null,
  p_fixed_conversion_factor numeric default null,
  p_secondary_usage_unit_code text default null,
  p_secondary_conversion_factor numeric default null,
  p_secondary_requires_measurement boolean default false
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
  v_base_iiu_id uuid;
  v_purchase_unit_id uuid;
  v_line record;
  v_classification_id uuid;
  v_vendor_id uuid;
  v_purchase_document record;
  v_duplicate record;
  v_vendor_item_purchase_unit_id uuid;
  v_existing_classification record;
  v_mapping_id uuid;
begin
  if p_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid disposition %', p_disposition;
  end if;

  if p_spend_category_id is null then
    raise exception 'a spend category is required to confirm a new item' using errcode = 'GA013';
  end if;

  if p_receiving_behavior is not null and p_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid receiving behavior %', p_receiving_behavior;
  end if;

  if p_disposition <> 'INVENTORY' and p_secondary_usage_unit_code is not null then
    raise exception 'a non-inventory item cannot have a kiosk usage unit configuration' using errcode = 'GA065';
  end if;

  select status, created_by_app_user_id into v_purchase_document
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_purchase_document.status = 'DRAFT' and v_purchase_document.created_by_app_user_id is distinct from p_app_user_id
     and not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.correct_any_draft') then
    raise exception 'app_user % is not the preparer of purchase_document % and may not approve item classifications on its draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  if v_purchase_document.status = 'READY_FOR_VERIFICATION' then
    if v_purchase_document.created_by_app_user_id = p_app_user_id then
      raise exception 'app_user % prepared purchase_document % and cannot review-correct its item resolution', p_app_user_id, p_purchase_document_id
        using errcode = 'GA004';
    end if;
    if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
      raise exception 'purchase_document % is in final review: reviewer item-resolution corrections are proposals applied atomically by Final Verify, never direct writes', p_purchase_document_id
        using errcode = 'GA003';
    end if;
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
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

  -- Same-key/different-payload replay protection: if this exact line was
  -- already confirmed against a DIFFERENT item than this call would
  -- resolve to, fail closed rather than silently reassigning a completed
  -- approval. A pure retry (same pending_item_id / same freshly-resolved
  -- item) is unaffected -- it proceeds and lands on the same idempotent
  -- state via the ON CONFLICT below.
  select inventory_item_id, status into v_existing_classification
    from public.purchase_document_line_classifications
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
     and line_key = p_line_key;

  if found and v_existing_classification.status = 'CONFIRMED'
     and v_existing_classification.inventory_item_id is distinct from p_pending_item_id
     and p_pending_item_id is not null
  then
    raise exception 'line % was already confirmed against a different item; reopen it before resubmitting different values', p_line_key
      using errcode = 'GA062';
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

  if p_disposition = 'INVENTORY' and p_purchase_unit_code is not null and p_purchase_unit_code <> p_base_unit_code then
    select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
    if v_purchase_unit_id is null then
      raise exception 'unknown unit code %', p_purchase_unit_code;
    end if;

    if p_receiving_behavior = 'FIXED_CONVERSION' and (p_fixed_conversion_factor is null or p_fixed_conversion_factor <= 0) then
      raise exception 'a positive fixed_conversion_factor is required for FIXED_CONVERSION';
    end if;
  end if;

  select id, name into v_duplicate
    from public.inventory_items
   where organization_id = p_organization_id
     and status = 'active'
     and approval_status = 'CONFIRMED'
     and public.normalize_item_name(name) = public.normalize_item_name(p_final_name)
     and id is distinct from coalesce(p_pending_item_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if found then
    raise exception 'an active item named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA016', detail = jsonb_build_object('existingItemId', v_duplicate.id, 'existingItemName', v_duplicate.name)::text;
  end if;

  if p_pending_item_id is not null then
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

  -- Base-unit conversion row (unchanged from before this migration).
  if p_disposition = 'INVENTORY' then
    select id into v_base_iiu_id from public.inventory_item_units
     where inventory_item_id = v_item_id and unit_id = v_base_unit_id;

    if v_base_iiu_id is null then
      insert into public.inventory_item_units (
        inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
      ) values (
        v_item_id, v_base_unit_id, 1, false, true, true
      ) returning id into v_base_iiu_id;
    end if;

    -- Primary kiosk usage slot -- always the base-unit row, always slot 1.
    if not exists (
      select 1 from public.inventory_item_usage_units
       where organization_id = p_organization_id and inventory_item_id = v_item_id and usage_slot = 1 and is_active
    ) then
      insert into public.inventory_item_usage_units (
        organization_id, inventory_item_id, inventory_item_unit_id, usage_slot, is_active, confirmed_by_app_user_id, confirmed_at
      ) values (
        p_organization_id, v_item_id, v_base_iiu_id, 1, true, p_app_user_id, now()
      );
    end if;

    if p_secondary_usage_unit_code is not null then
      perform public.upsert_secondary_usage_unit(
        p_organization_id, v_item_id, p_secondary_usage_unit_code, p_secondary_conversion_factor, p_app_user_id, p_secondary_requires_measurement
      );
    end if;
  end if;

  -- Vendor purchase package -- keyed to the vendor-SKU identity, never
  -- the bare (item, unit) pair, so a second vendor (or a second SKU from
  -- the same vendor) can never collide with this one.
  if v_purchase_unit_id is not null and p_receiving_behavior is distinct from 'SAME_UNIT' and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id);
    elsif v_line.description is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;

    if v_mapping_id is not null then
      v_vendor_item_purchase_unit_id := public.upsert_vendor_item_purchase_unit(
        p_organization_id, v_mapping_id, v_vendor_id, v_item_id, v_purchase_unit_id, p_receiving_behavior,
        case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
        p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY'),
        p_app_user_id
      );
    end if;
  elsif p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id);
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at, vendor_item_purchase_unit_id
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, p_disposition,
    v_item_id, p_spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now(), v_vendor_item_purchase_unit_id
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at,
    vendor_item_purchase_unit_id = excluded.vendor_item_purchase_unit_id
  returning id into v_classification_id;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_APPROVED', 'inventory_item', v_item_id,
    jsonb_build_object(
      'name', p_final_name, 'disposition', p_disposition,
      'purchaseUnitCode', p_purchase_unit_code, 'receivingBehavior', p_receiving_behavior, 'fixedConversionFactor', p_fixed_conversion_factor,
      'secondaryUsageUnitCode', p_secondary_usage_unit_code, 'secondaryConversionFactor', p_secondary_conversion_factor,
      'secondaryRequiresMeasurement', p_secondary_requires_measurement
    ));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item_id, 'newItem', true));

  return query select v_item_id, v_classification_id;
end;
$$;

revoke all on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric, boolean
) from public;
grant execute on function public.approve_line_classification_new_item(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, text, uuid, boolean, text, text, numeric, text, numeric, boolean
) to service_role;

create or replace function public.approve_line_classification_existing_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_remember_vendor_mapping boolean default true,
  p_purchase_unit_code text default null,
  p_receiving_behavior text default null,
  p_fixed_conversion_factor numeric default null
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
  v_purchase_document record;
  v_base_unit_code text;
  v_purchase_unit_id uuid;
  v_mapping_id uuid;
  v_vendor_item_purchase_unit_id uuid;
begin
  select status, created_by_app_user_id into v_purchase_document
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_purchase_document.status = 'DRAFT' and v_purchase_document.created_by_app_user_id is distinct from p_app_user_id
     and not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.correct_any_draft') then
    raise exception 'app_user % is not the preparer of purchase_document % and may not approve item classifications on its draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  if v_purchase_document.status = 'READY_FOR_VERIFICATION' then
    if v_purchase_document.created_by_app_user_id = p_app_user_id then
      raise exception 'app_user % prepared purchase_document % and cannot review-correct its item resolution', p_app_user_id, p_purchase_document_id
        using errcode = 'GA004';
    end if;
    if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
      raise exception 'purchase_document % is in final review: reviewer item-resolution corrections are proposals applied atomically by Final Verify, never direct writes', p_purchase_document_id
        using errcode = 'GA003';
    end if;
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
  end if;

  if p_receiving_behavior is not null and p_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid receiving behavior %', p_receiving_behavior;
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

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if p_purchase_unit_code is not null and v_item.disposition = 'INVENTORY' and v_vendor_id is not null then
    select u.code into v_base_unit_code
      from public.inventory_items ii join public.units u on u.id = ii.base_unit_id
     where ii.id = p_inventory_item_id;

    if p_purchase_unit_code <> v_base_unit_code then
      select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
      if v_purchase_unit_id is null then
        raise exception 'unknown unit code %', p_purchase_unit_code;
      end if;
      if p_receiving_behavior = 'FIXED_CONVERSION' and (p_fixed_conversion_factor is null or p_fixed_conversion_factor <= 0) then
        raise exception 'a positive fixed_conversion_factor is required for FIXED_CONVERSION';
      end if;
    end if;
  end if;

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

  if v_purchase_unit_id is not null and p_receiving_behavior is distinct from 'SAME_UNIT' then
    if v_line.vendor_sku is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id);
    elsif v_line.description is not null then
      v_mapping_id := public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item.id, p_app_user_id
      );
    end if;

    if v_mapping_id is not null then
      v_vendor_item_purchase_unit_id := public.upsert_vendor_item_purchase_unit(
        p_organization_id, v_mapping_id, v_vendor_id, v_item.id, v_purchase_unit_id, p_receiving_behavior,
        case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
        p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY'),
        p_app_user_id
      );
      update public.purchase_document_line_classifications
         set vendor_item_purchase_unit_id = v_vendor_item_purchase_unit_id
       where id = v_classification_id;
    end if;
  elsif p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id);
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

revoke all on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean, text, text, numeric) from public;
grant execute on function public.approve_line_classification_existing_item(uuid, uuid, uuid, uuid, uuid, boolean, text, text, numeric) to service_role;
