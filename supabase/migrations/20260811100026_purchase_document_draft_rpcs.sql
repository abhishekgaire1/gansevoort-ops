-- Milestone 2A.2: purchase document draft RPCs
--
-- initialize_purchase_document_draft and save_purchase_document_draft are
-- both PREPARER-ONLY: only the app_user who uploaded the source document
-- (documents.uploaded_by_app_user_id -- immutable, permanently fixed at
-- upload time) may create or edit a draft. This is checked as a plain read
-- before the real work, not folded into the atomic status/version UPDATE
-- below it -- safe specifically because uploaded_by_app_user_id can never
-- change, so there is no race window between the check and the rest of
-- the function. A different manager/admin may only read a submitted
-- record, verify it, or return it to draft (20260811100027) -- never edit
-- draft content.
--
-- Every RETURNS TABLE output column is `out_`-prefixed so it structurally
-- cannot collide with a same-named real column the function body touches
-- (the exact bug class fixed in 20260811100022_fix_finalize_document_upload_rpc.sql)
-- -- on top of, not instead of, fully aliasing every table and qualifying
-- every column reference throughout.

-- Gemini's extracted date strings are free text, not guaranteed ISO -- a
-- blind ::date cast could throw on a real malformed value and abort the
-- whole atomic draft-initialization transaction for that document. Returns
-- NULL on any cast failure instead of raising; the manager corrects a
-- missing date via the editable field during review. Every numeric field
-- pulled from normalized_extraction is safe to cast directly (it was
-- already `number | null` in the Zod-validated extraction JSON, never a
-- free-text string), so only dates need this treatment.
create or replace function public.safe_parse_date(p_text text)
returns date
language plpgsql
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end;
$$;

revoke all on function public.safe_parse_date(text) from public;
grant execute on function public.safe_parse_date(text) to service_role;

-- Idempotent no-op if a purchase_document already exists for this
-- document (enforced by purchase_documents_org_source_document_key) --
-- never re-initializes, never overwrites a manager-edited draft even if a
-- newer SUCCEEDED extraction attempt now exists. Pre-fills vendor_id/
-- document_type from the human-declared documents columns (not Gemini's
-- guess) -- a human declaration at intake is a more reliable starting
-- point than an AI guess, now that one exists.
create or replace function public.initialize_purchase_document_draft(
  p_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uploaded_by uuid;
  v_declared_vendor_id uuid;
  v_declared_document_type text;
  v_existing_id uuid;
  v_existing_status text;
  v_extraction_id uuid;
  v_normalized jsonb;
  v_new_id uuid;
begin
  select d.uploaded_by_app_user_id, d.vendor_id, d.declared_document_type
    into v_uploaded_by, v_declared_vendor_id, v_declared_document_type
    from public.documents d
   where d.id = p_document_id
     and d.organization_id = p_organization_id;

  if not found then
    raise exception 'document % not found', p_document_id;
  end if;

  if v_uploaded_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the uploader of document % and may not create its draft', p_app_user_id, p_document_id
      using errcode = 'GA006';
  end if;

  select pd.id, pd.status into v_existing_id, v_existing_status
    from public.purchase_documents pd
   where pd.source_document_id = p_document_id
     and pd.organization_id = p_organization_id;

  if found then
    return query select v_existing_id, v_existing_status, false;
    return;
  end if;

  select de.id, de.normalized_extraction
    into v_extraction_id, v_normalized
    from public.document_extractions de
   where de.document_id = p_document_id
     and de.organization_id = p_organization_id
     and de.status = 'SUCCEEDED'
   order by de.attempt_number desc
   limit 1;

  if not found then
    raise exception 'document % has no SUCCEEDED extraction attempt to initialize a draft from', p_document_id;
  end if;

  v_new_id := gen_random_uuid();

  insert into public.purchase_documents as pd (
    id, organization_id, source_document_id, source_extraction_id,
    vendor_id, document_type,
    document_number, document_date, po_number, delivery_date,
    subtotal, tax, fees, total, currency,
    status, created_by_app_user_id
  ) values (
    v_new_id, p_organization_id, p_document_id, v_extraction_id,
    v_declared_vendor_id, v_declared_document_type,
    v_normalized->>'invoiceNumber', public.safe_parse_date(v_normalized->>'invoiceDate'),
    v_normalized->>'purchaseOrderNumber', public.safe_parse_date(v_normalized->>'deliveryDate'),
    (v_normalized->>'subtotal')::numeric, (v_normalized->>'tax')::numeric,
    (v_normalized->>'fees')::numeric, (v_normalized->>'total')::numeric, v_normalized->>'currency',
    'DRAFT', p_app_user_id
  );

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, v_new_id, ord.idx,
    ord.line_json->>'vendorSku', ord.line_json->>'description',
    (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
    (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
    (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
    (ord.line_json->>'lineTotal')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(coalesce(v_normalized->'lines', '[]'::jsonb))
  ) as ord;

  return query select v_new_id, 'DRAFT'::text, true;
end;
$$;

revoke all on function public.initialize_purchase_document_draft(uuid, uuid, uuid) from public;
grant execute on function public.initialize_purchase_document_draft(uuid, uuid, uuid) to service_role;

-- Preparer-only (see header comment). Requires status='DRAFT' and a
-- matching version, both enforced inside the ONE atomic UPDATE below
-- (never a separate SELECT-then-compare, which would leave a TOCTOU
-- window). The header UPDATE runs, and its row lock is acquired, BEFORE
-- the line replace-all -- so a concurrent verify/submit call on the same
-- row correctly blocks until this whole transaction resolves rather than
-- interleaving with it.
create or replace function public.save_purchase_document_draft(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb,
  p_lines jsonb
)
returns table (
  out_purchase_document_id uuid,
  out_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uploaded_by uuid;
  v_new_version integer;
begin
  select d.uploaded_by_app_user_id into v_uploaded_by
    from public.documents d
    join public.purchase_documents pd on pd.source_document_id = d.id and pd.organization_id = d.organization_id
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_uploaded_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not edit it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
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
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be saved: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  delete from public.purchase_document_lines as pdl
   where pdl.purchase_document_id = p_purchase_document_id;

  insert into public.purchase_document_lines as pdl (
    id, organization_id, purchase_document_id, line_number,
    vendor_sku, description, package_quantity, package_unit,
    measured_quantity, measured_unit, unit_price, price_basis_unit, line_total
  )
  select
    gen_random_uuid(), p_organization_id, p_purchase_document_id, ord.idx,
    ord.line_json->>'vendorSku', ord.line_json->>'description',
    (ord.line_json->>'packageQuantity')::numeric, ord.line_json->>'packageUnit',
    (ord.line_json->>'measuredQuantity')::numeric, ord.line_json->>'measuredUnit',
    (ord.line_json->>'unitPrice')::numeric, ord.line_json->>'priceBasisUnit',
    (ord.line_json->>'lineTotal')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  ) as ord;

  return query select p_purchase_document_id, v_new_version;
end;
$$;

revoke all on function public.save_purchase_document_draft(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
grant execute on function public.save_purchase_document_draft(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;
