-- Fixes an ordering defect in submit_purchase_document_for_verification's
-- atomic save-and-submit path (added in 20260811100031), found by its own
-- regression test before this was ever manually tested: when p_header is
-- supplied, the function replaced purchase_document_lines FIRST (safe only
-- because the row was assumed to still be DRAFT) and only checked
-- status/version afterward, in the final header UPDATE. If a concurrent
-- caller had already transitioned the row to READY_FOR_VERIFICATION in the
-- meantime (the exact scenario a stale expected_version is meant to catch),
-- the lines DELETE hit purchase_document_lines_forbid_when_locked's
-- unconditional READY_FOR_VERIFICATION lock first, surfacing GA003
-- ("this document is verified/locked") instead of the correct GA002
-- ("stale version, reload"). The transaction still rolled back completely
-- either way (no data corruption, no partial state), but the error
-- classification was wrong, and the user's own instruction for this
-- feature was explicit: a stale submit/verify attempt must produce the
-- existing stale/current-state error, never anything else.
--
-- Fix: before touching purchase_document_lines at all, acquire a row lock
-- and explicitly verify status = 'DRAFT' and version = p_expected_version
-- (raising GA002 immediately if not), so a stale caller is rejected before
-- any side effect is attempted. verify_purchase_document's atomic path
-- already had this property (its own header UPDATE, which carries the
-- real version/status gate, always runs before any line is touched) and is
-- unchanged here.

create or replace function public.submit_purchase_document_for_verification(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb default null,
  p_lines jsonb default null
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_new_version integer;
  v_snapshot jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not submit it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  if p_header is not null then
    -- Lock the row and confirm it is still exactly the DRAFT/version the
    -- caller expects BEFORE any side effect (lines are only unrestricted
    -- to mutate while genuinely still DRAFT) -- a concurrently-submitted
    -- row is rejected here, as a clean GA002, never surfacing the lines
    -- trigger's GA003 instead.
    perform 1 from public.purchase_documents
     where id = p_purchase_document_id
       and organization_id = p_organization_id
       and status = 'DRAFT'
       and version = p_expected_version
       for update;

    if not found then
      raise exception 'purchase_document % could not be submitted: not a DRAFT, or the version is stale', p_purchase_document_id
        using errcode = 'GA002';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
      where line.value ->> 'lineKey' is not null
      group by line.value ->> 'lineKey'
      having count(*) > 1
    ) then
      raise exception 'duplicate line_key values in submitted lines for purchase_document %', p_purchase_document_id;
    end if;

    delete from public.purchase_document_lines as pdl
     where pdl.purchase_document_id = p_purchase_document_id;

    insert into public.purchase_document_lines as pdl (
      id, organization_id, purchase_document_id, line_number, line_key,
      vendor_sku, description, package_quantity, package_unit,
      measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
    )
    select
      gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
      coalesce((ord.line_json->>'lineKey')::uuid, gen_random_uuid()),
      ord.line_json->>'vendorSku', ord.line_json->>'description',
      (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
      (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
      (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
      (ord.line_json->>'lineTotal')::numeric
    from (
      select value as line_json, row_number() over () as idx
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
    ) as ord;

    -- The row lock above already guarantees status/version are still
    -- exactly what was checked, so this UPDATE's WHERE clause cannot fail
    -- to find the row -- it's kept for defense in depth and to compute
    -- v_new_version via the same RETURNING pattern used everywhere else.
    update public.purchase_documents as pd
       set vendor_id = (p_header->>'vendorId')::uuid,
           document_type = p_header->>'documentType',
           document_number = p_header->>'documentNumber',
           document_date = public.safe_parse_date(p_header->>'documentDate'),
           po_number = p_header->>'poNumber',
           delivery_date = public.safe_parse_date(p_header->>'deliveryDate'),
           subtotal = (p_header->>'subtotal')::numeric,
           tax = (p_header->>'tax')::numeric,
           fees = (p_header->>'fees')::numeric,
           total = (p_header->>'total')::numeric,
           currency = p_header->>'currency',
           status = 'READY_FOR_VERIFICATION',
           version = pd.version + 1
     where pd.id = p_purchase_document_id
       and pd.organization_id = p_organization_id
       and pd.status = 'DRAFT'
       and pd.version = p_expected_version
       and (p_header->>'vendorId') is not null
       and exists (
         select 1 from public.vendors v
          where v.id = (p_header->>'vendorId')::uuid and v.organization_id = p_organization_id and v.is_active
       )
       and (p_header->>'documentType') in ('INVOICE', 'RECEIPT', 'CREDIT_MEMO')
       and jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 0
     returning pd.version into v_new_version;

    if not found then
      raise exception 'purchase_document % could not be submitted: not a DRAFT, version is stale, vendor is missing/inactive, document type is unresolved, or there are no lines', p_purchase_document_id
        using errcode = 'GA002';
    end if;
  else
    -- Legacy/no-current-edits path -- pure status transition against
    -- whatever is already persisted. Unchanged from before this migration.
    update public.purchase_documents as pd
       set status = 'READY_FOR_VERIFICATION',
           version = pd.version + 1
     where pd.id = p_purchase_document_id
       and pd.organization_id = p_organization_id
       and pd.status = 'DRAFT'
       and pd.version = p_expected_version
       and pd.vendor_id is not null
       and exists (
         select 1 from public.vendors v
          where v.id = pd.vendor_id and v.organization_id = pd.organization_id and v.is_active
       )
       and pd.document_type in ('INVOICE', 'RECEIPT', 'CREDIT_MEMO')
       and exists (
         select 1 from public.purchase_document_lines pdl where pdl.purchase_document_id = pd.id
       )
     returning pd.version into v_new_version;

    if not found then
      raise exception 'purchase_document % could not be submitted: not a DRAFT, version is stale, vendor is missing/inactive, document type is unresolved, or there are no lines', p_purchase_document_id
        using errcode = 'GA002';
    end if;
  end if;

  select jsonb_build_object(
    'version', pd.version,
    'vendor_id', pd.vendor_id,
    'document_type', pd.document_type,
    'document_number', pd.document_number,
    'document_date', pd.document_date,
    'po_number', pd.po_number,
    'delivery_date', pd.delivery_date,
    'subtotal', pd.subtotal,
    'tax', pd.tax,
    'fees', pd.fees,
    'total', pd.total,
    'currency', pd.currency,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'line_key', pdl.line_key,
        'line_number', pdl.line_number,
        'vendor_sku', pdl.vendor_sku,
        'description', pdl.description,
        'package_quantity', pdl.package_quantity,
        'package_unit', pdl.package_unit,
        'measured_quantity', pdl.measured_quantity,
        'measured_unit', pdl.measured_unit,
        'unit_price', pdl.unit_price,
        'price_basis_unit', pdl.price_basis_unit,
        'line_total', pdl.line_total
      ) order by pdl.line_number), '[]'::jsonb)
      from public.purchase_document_lines pdl
      where pdl.purchase_document_id = pd.id
    )
  )
    into v_snapshot
    from public.purchase_documents pd
   where pd.id = p_purchase_document_id;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SUBMITTED', 'purchase_document', p_purchase_document_id, v_snapshot
  );

  return query select p_purchase_document_id, 'READY_FOR_VERIFICATION'::text, v_new_version;
end;
$$;
