-- 2A.3 refinement (part 4): supersedes the ORIGINAL 2A.3 plan's §16 rule
-- ("classification/receiving must never block verification"). Under the
-- clarified operational workflow, the FIRST manager (preparer) is
-- responsible for substantially completing item mapping/new-item setup/
-- receiving BEFORE sending the document to the second manager -- Send for
-- Final Review (submit_purchase_document_for_verification) is now gated on
-- that preparation being complete for every CURRENT relevant line. A
-- manager may still save/leave an incomplete document at any time; only
-- the transition to READY_FOR_VERIFICATION itself is blocked.
--
-- "Complete" for a CURRENT line means:
--   - a CONFIRMED classification exists (never UNCLASSIFIED/PENDING_REVIEW/
--     STALE -- a STALE row is deliberately treated the same as unresolved,
--     never silently accepted)
--   - for a CONFIRMED INVENTORY line specifically (a NON_INVENTORY line's
--     completeness stops at classification -- it is never blocked by
--     receiving/measurement/location, which are meaningless for it): an
--     effective (non-superseded) receipt_lines row matched to that exact
--     line_key exists, with a received quantity, a location, AND -- only
--     when the item's own confirmed purchase-unit configuration requires
--     it (requires_actual_measurement=true, i.e. MEASURE_EACH_DELIVERY/
--     COUNT_EACH_DELIVERY) -- a verified base quantity. This mirrors
--     app/lib/receiving/getReceivingLines.ts's exact derivation, just
--     re-expressed in SQL as the authoritative backstop (the UI's own
--     pre-check is what gives a manager the rich per-line reasons; this is
--     defense in depth, never bypassable by a client that skips it).
--
-- Defined before submit_purchase_document_for_verification below (which
-- calls it) purely for readability -- plpgsql itself resolves function
-- calls at first execution, not at CREATE time, so the order wouldn't
-- actually matter, but a reader shouldn't have to know that.
create or replace function public.purchase_document_preparation_incomplete(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.purchase_document_lines pdl
    left join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
    where pdl.purchase_document_id = p_purchase_document_id
      and pdl.organization_id = p_organization_id
      and (
        c.id is null
        or c.status in ('PENDING_REVIEW', 'STALE')
        or (
          c.status = 'CONFIRMED'
          and c.disposition = 'INVENTORY'
          and not exists (
            select 1
            from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
            join public.receipt_lines rl on rl.receipt_id = er.id
            where rl.matched_line_key = pdl.line_key
              and rl.actual_received_package_quantity is not null
              and rl.location_id is not null
              and (
                rl.actual_verified_base_quantity is not null
                or not exists (
                  select 1
                  from public.inventory_item_units iiu
                  where iiu.inventory_item_id = c.inventory_item_id
                    and iiu.unit_id <> (select ii.base_unit_id from public.inventory_items ii where ii.id = c.inventory_item_id)
                    and iiu.requires_actual_measurement
                )
              )
          )
        )
      )
  );
$$;

revoke all on function public.purchase_document_preparation_incomplete(uuid, uuid) from public;
grant execute on function public.purchase_document_preparation_incomplete(uuid, uuid) to service_role;

-- submit_purchase_document_for_verification already exists (20260811100031,
-- corrected in 20260811100032) with a STABLE 6-parameter signature -- this
-- migration changes ONLY the body via CREATE OR REPLACE with the IDENTICAL
-- signature, the same safe "body-only replace" pattern 100031->100032
-- itself already used. No drop is needed here (unlike 100043/100044/100045,
-- which changed parameter LISTS).
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

    if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
      raise exception 'purchase_document % has incomplete item mapping/receiving preparation', p_purchase_document_id
        using errcode = 'GA013';
    end if;

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
    if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
      raise exception 'purchase_document % has incomplete item mapping/receiving preparation', p_purchase_document_id
        using errcode = 'GA013';
    end if;

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
