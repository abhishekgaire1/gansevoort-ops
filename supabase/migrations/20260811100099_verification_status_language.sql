-- Status Language -- Verification milestone.
--
-- Presentation-only: the canonical purchase_documents.status enum
-- (DRAFT/READY_FOR_VERIFICATION/VERIFIED/DISCARDED) is completely
-- unchanged. What changes:
--   1. search_receiving_queue gains ONE new output column
--      (out_created_by_app_user_id) so the TypeScript layer can tell,
--      per row, whether the CURRENT viewer is the document's own
--      preparer or a different (eligible-to-verify) manager -- the
--      existing out_uploaded_by_app_user_id is the wrong field for this:
--      it's the ORIGINAL document uploader, which can differ from the
--      current revision's preparer on an amendment. Same maker/checker
--      identity (purchase_documents.created_by_app_user_id) the app
--      already uses everywhere else to decide self-verification
--      eligibility (see PurchaseDocumentReviewView.tsx's isPreparer).
--   2. submit_purchase_document_for_verification (body-only replace,
--      same signature) now ALSO writes two kinds of user_notifications
--      at the moment a document is actually submitted -- a gap, not a
--      behavior change: today no notification exists at submit time at
--      all, only after verification. One confirmation to the preparer
--      themselves ("sent"), and one to every OTHER active manager/admin
--      in the org ("needs your verification"). Never touches
--      maker/checker enforcement, the completion gate, or the version/
--      status transition logic above it.

drop function if exists public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer);

create function public.search_receiving_queue(
  p_organization_id uuid,
  p_vendor_id uuid default null,
  p_uploaded_by_app_user_id uuid default null,
  p_status text default null,
  p_document_type text default null,
  p_date_type text default 'uploaded',
  p_date_from date default null,
  p_date_to date default null,
  p_query text default null,
  p_limit integer default 200
)
returns table (
  out_document_id uuid,
  out_original_filename text,
  out_content_type text,
  out_created_at timestamptz,
  out_uploaded_by_app_user_id uuid,
  out_purchase_document_id uuid,
  out_effective_vendor_id uuid,
  out_effective_document_type text,
  out_declared_vendor_id uuid,
  out_declared_document_type text,
  out_document_number text,
  out_document_date date,
  out_status text,
  out_verified_by_app_user_id uuid,
  out_revision_number integer,
  out_current_verified_revision_number integer,
  out_created_by_app_user_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with merged as (
    select
      d.id as document_id,
      d.original_filename,
      d.content_type,
      d.created_at,
      d.uploaded_by_app_user_id,
      d.vendor_id as declared_vendor_id,
      d.declared_document_type,
      pd.id as purchase_document_id,
      coalesce(pd.vendor_id, d.vendor_id) as effective_vendor_id,
      coalesce(pd.document_type, d.declared_document_type) as effective_document_type,
      pd.document_number,
      pd.document_date,
      pd.verified_by_app_user_id,
      pd.revision_number,
      pd.created_by_app_user_id,
      current_verified.revision_number as current_verified_revision_number,
      case
        when pd.status is not null then pd.status
        when la.document_id is null then 'FAILED'
        when la.attempt_status = 'SUCCEEDED' then 'NEEDS_REVIEW'
        when la.attempt_status = 'FAILED' then 'FAILED'
        when la.attempt_status in ('PENDING', 'RUNNING') then
          case
            when now() - coalesce(
              case when la.attempt_status = 'RUNNING' then la.started_at end,
              la.requested_at
            ) > interval '5 minutes'
            then 'STALLED'
            else 'PROCESSING'
          end
        else 'FAILED'
      end as computed_status
    from public.documents d
    left join lateral (
      select pd.*
        from public.purchase_documents pd
       where pd.source_document_id = d.id and pd.organization_id = d.organization_id
         and pd.status <> 'DISCARDED'
       order by (pd.status <> 'VERIFIED') desc, pd.revision_number desc
       limit 1
    ) pd on true
    left join lateral (
      select cv.revision_number
        from public.purchase_documents cv
       where cv.revision_group_id = pd.revision_group_id and cv.status = 'VERIFIED'
       order by cv.revision_number desc
       limit 1
    ) current_verified on true
    left join lateral (
      select de.document_id, de.status as attempt_status, de.requested_at, de.started_at
      from public.document_extractions de
      where de.organization_id = p_organization_id
        and de.document_id = d.id
      order by de.attempt_number desc
      limit 1
    ) la on true
    where d.organization_id = p_organization_id
      and not exists (select 1 from public.document_archives da where da.document_id = d.id)
      and not (
        pd.id is null
        and exists (
          select 1 from public.purchase_documents pd_discarded
           where pd_discarded.source_document_id = d.id
             and pd_discarded.organization_id = d.organization_id
             and pd_discarded.revision_number = 1
             and pd_discarded.status = 'DISCARDED'
        )
      )
      -- Pushed-down filters (none depend on derived columns):
      and (p_vendor_id is null or coalesce(pd.vendor_id, d.vendor_id) = p_vendor_id)
      and (p_uploaded_by_app_user_id is null or d.uploaded_by_app_user_id = p_uploaded_by_app_user_id)
      and (p_document_type is null or coalesce(pd.document_type, d.declared_document_type) = p_document_type)
      -- Business Document Date: only purchase_documents.document_date, never
      -- Gemini's extracted date -- a row with no recorded business date is
      -- excluded from this filter mode entirely, not silently matched.
      and (
        p_date_type <> 'business'
        or (
          pd.document_date is not null
          and (p_date_from is null or pd.document_date >= p_date_from)
          and (p_date_to is null or pd.document_date <= p_date_to)
        )
      )
      -- Uploaded Date: always documents.created_at.
      and (
        p_date_type = 'business'
        or (
          (p_date_from is null or d.created_at >= p_date_from::timestamptz)
          and (p_date_to is null or d.created_at < (p_date_to + 1)::timestamptz)
        )
      )
  )
  select
    m.document_id, m.original_filename, m.content_type, m.created_at, m.uploaded_by_app_user_id,
    m.purchase_document_id, m.effective_vendor_id, m.effective_document_type,
    m.declared_vendor_id, m.declared_document_type,
    m.document_number, m.document_date, m.computed_status, m.verified_by_app_user_id,
    m.revision_number, m.current_verified_revision_number, m.created_by_app_user_id
  from merged m
  -- Derived-column filters -- still strictly BEFORE the limit.
  where (p_status is null or m.computed_status = p_status)
    and (
      p_query is null or btrim(p_query) = ''
      or m.original_filename ilike '%' || p_query || '%'
      or m.document_number ilike '%' || p_query || '%'
    )
  order by m.created_at desc
  limit p_limit;
$$;

revoke all on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer) from public;
grant execute on function public.search_receiving_queue(uuid, uuid, uuid, text, text, text, date, date, text, integer) to service_role;

-- ============================================================
-- submit_purchase_document_for_verification -- body-only replace, same
-- 6-parameter signature (20260811100056's own precedent for this exact
-- function). Adds submit-time notifications only; every existing check
-- (preparer-only, completion gate, delivery verifier, plausible date,
-- version/status transition, PURCHASE_DOCUMENT_SUBMITTED audit event) is
-- reproduced byte-for-byte from 20260811100056.
-- ============================================================
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
  v_incoming_date date;
  v_document_number text;
  v_doc_type_label text;
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

    v_incoming_date := public.safe_parse_date(p_header->>'documentDate');
    if public.purchase_document_has_implausible_date(v_incoming_date) then
      raise exception 'purchase_document % has an implausible document date %', p_purchase_document_id, p_header->>'documentDate'
        using errcode = 'GA013';
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

    if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
      raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
        using errcode = 'GA013';
    end if;

    update public.purchase_documents as pd
       set vendor_id = (p_header->>'vendorId')::uuid,
           document_type = p_header->>'documentType',
           document_number = p_header->>'documentNumber',
           document_date = v_incoming_date,
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

    if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
      raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
        using errcode = 'GA013';
    end if;

    if exists (
      select 1 from public.purchase_documents
       where id = p_purchase_document_id
         and organization_id = p_organization_id
         and public.purchase_document_has_implausible_date(document_date)
    ) then
      raise exception 'purchase_document % has an implausible document date', p_purchase_document_id
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

  -- ============================================================
  -- Submit-time notifications (Status Language -- Verification milestone).
  -- A genuine gap being filled here, not a behavior change: previously no
  -- notification existed at submit time at all. Never touches
  -- maker/checker enforcement above -- purely informational rows.
  -- ============================================================
  v_document_number := v_snapshot->>'document_number';
  v_doc_type_label := case v_snapshot->>'document_type'
    when 'CREDIT_MEMO' then 'Credit Memo'
    when 'RECEIPT' then 'Receipt'
    else 'Invoice'
  end;

  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SUBMITTED_CONFIRMATION', 'purchase_document', p_purchase_document_id,
    'Sent for verification',
    format('%s #%s was sent for verification.', v_doc_type_label, coalesce(v_document_number, 'Document')),
    '{}'::jsonb
  );

  -- Every OTHER active manager/admin in the org is an eligible verifier
  -- under the existing maker/checker rule (self-verification is the only
  -- restriction, enforced elsewhere -- this insert grants no permission,
  -- it only informs people who already have the standing capability).
  insert into public.user_notifications (
    organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
  )
  select p_organization_id, au.id, 'PURCHASE_DOCUMENT_NEEDS_VERIFICATION', 'purchase_document', p_purchase_document_id,
    'Needs your verification',
    format('%s #%s needs your verification.', v_doc_type_label, coalesce(v_document_number, 'Document')),
    jsonb_build_object('submittedByAppUserId', p_app_user_id)
  from public.app_users au
  where au.organization_id = p_organization_id
    and au.is_active
    and au.id <> p_app_user_id
    and exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
       where ur.app_user_id = au.id and r.name in ('manager', 'admin')
    );

  return query select p_purchase_document_id, 'READY_FOR_VERIFICATION'::text, v_new_version;
end;
$$;

revoke all on function public.submit_purchase_document_for_verification(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
grant execute on function public.submit_purchase_document_for_verification(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;
