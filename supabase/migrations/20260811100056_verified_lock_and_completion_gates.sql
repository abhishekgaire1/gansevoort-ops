-- Post-verification data-integrity fixes, investigated against a real
-- Gansevoort DEV document (Bartlett #3614450): once Manager 2 Final
-- Verifies, the completed 2A.3 preparation must be immutable through
-- every normal mutation path -- not merely a UI restriction. This
-- migration extends the exact SAME "VERIFIED unconditional, READY_FOR_
-- VERIFICATION gated by the gansevoort.purchase_document_ready_write
-- sanctioned-write flag" pattern already proven correct for
-- purchase_document_lines (20260811100025/100029/100033) to every other
-- table that can affect this transaction's preparation, and adds two
-- completion-gate checks that real data proved were missing entirely.

-- ============================================================
-- 1. Lock purchase_document_line_classifications
-- ============================================================
-- Deliberately NOT foreign-keyed to purchase_document_lines (see
-- 20260811100037's own design note) -- this lock is enforced the same
-- way purchase_document_lines' own lock is: a trigger keyed off the
-- PARENT purchase_document's status, not a physical FK. The sanctioned-
-- write flag lets invalidate_stale_line_classification's own UPDATE
-- (fired automatically by save_purchase_document_review_corrections'
-- line reinsert, while READY_FOR_VERIFICATION) keep working -- that
-- flow is a legitimate, already-shipped exception; a manual
-- approve_line_classification_*/bulk_confirm_line_classifications call
-- is not, and is correctly blocked by the same check now.
create or replace function public.purchase_document_line_classifications_forbid_when_locked()
returns trigger
language plpgsql
as $$
declare
  v_parent_status text;
begin
  select pd.status into v_parent_status
    from public.purchase_documents pd
   where pd.id = coalesce(new.purchase_document_id, old.purchase_document_id);

  if v_parent_status in ('VERIFIED', 'DISCARDED') then
    raise exception 'purchase_document_line_classifications for purchase_document % cannot be modified: the purchase document is %',
      coalesce(new.purchase_document_id, old.purchase_document_id), v_parent_status
      using errcode = 'GA003';
  elsif v_parent_status = 'READY_FOR_VERIFICATION' then
    if coalesce(current_setting('gansevoort.purchase_document_ready_write', true), 'false') <> 'true' then
      raise exception 'purchase_document_line_classifications for purchase_document % cannot be modified: the purchase document is ready for verification and locked',
        coalesce(new.purchase_document_id, old.purchase_document_id)
        using errcode = 'GA003';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger purchase_document_line_classifications_forbid_when_locked
  before insert or update or delete on public.purchase_document_line_classifications
  for each row execute function public.purchase_document_line_classifications_forbid_when_locked();

-- ============================================================
-- 2. Lock purchase_document_line_invoice_unit_confirmations
-- ============================================================
-- Same pattern -- and since nothing ever writes here as a system-trigger
-- side effect (only confirm_receiving_line_invoice_unit, an explicit
-- manager action, ever inserts a row), this is effectively locked the
-- instant the document leaves DRAFT, with no sanctioned exception needed.
create or replace function public.pdl_invoice_unit_confirmations_forbid_when_locked()
returns trigger
language plpgsql
as $$
declare
  v_parent_status text;
begin
  select pd.status into v_parent_status
    from public.purchase_documents pd
   where pd.id = coalesce(new.purchase_document_id, old.purchase_document_id);

  if v_parent_status in ('VERIFIED', 'DISCARDED') then
    raise exception 'purchase_document_line_invoice_unit_confirmations for purchase_document % cannot be modified: the purchase document is %',
      coalesce(new.purchase_document_id, old.purchase_document_id), v_parent_status
      using errcode = 'GA003';
  elsif v_parent_status = 'READY_FOR_VERIFICATION' then
    if coalesce(current_setting('gansevoort.purchase_document_ready_write', true), 'false') <> 'true' then
      raise exception 'purchase_document_line_invoice_unit_confirmations for purchase_document % cannot be modified: the purchase document is ready for verification and locked',
        coalesce(new.purchase_document_id, old.purchase_document_id)
        using errcode = 'GA003';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger pdl_invoice_unit_confirmations_forbid_when_locked
  before insert or update or delete on public.purchase_document_line_invoice_unit_confirmations
  for each row execute function public.pdl_invoice_unit_confirmations_forbid_when_locked();

-- ============================================================
-- 3. Lock receipts -- CORRECTION vs a genuinely new DELIVERY differ
-- ============================================================
-- receipts/receipt_lines are already unconditionally forbidden from
-- UPDATE/DELETE (20260811100040) -- only INSERT needs a guard here.
-- A CORRECTION rewrites/reinterprets a fact about the already-reviewed
-- preparation -- locked exactly like classifications above. A DELIVERY
-- receipt records a genuinely NEW physical event (a real box arriving),
-- which must remain possible even after VERIFIED ("Record Additional
-- Delivery," always append-only, never touching an earlier receipt) --
-- but not mid-review (READY_FOR_VERIFICATION), where Manager 2 must be
-- looking at a stable snapshot, and not against a DISCARDED document.
create or replace function public.receipts_forbid_when_locked()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.purchase_documents where id = new.purchase_document_id;

  if new.receipt_kind = 'CORRECTION' then
    if v_status in ('VERIFIED', 'DISCARDED') then
      raise exception 'receipt for purchase_document % cannot be corrected: the purchase document is %', new.purchase_document_id, v_status
        using errcode = 'GA003';
    elsif v_status = 'READY_FOR_VERIFICATION' and coalesce(current_setting('gansevoort.purchase_document_ready_write', true), 'false') <> 'true' then
      raise exception 'receipt for purchase_document % cannot be corrected: the purchase document is ready for verification and locked', new.purchase_document_id
        using errcode = 'GA003';
    end if;
  else
    if v_status in ('READY_FOR_VERIFICATION', 'DISCARDED') then
      raise exception 'purchase_document % cannot record a new delivery while %', new.purchase_document_id, v_status
        using errcode = 'GA003';
    end if;
    -- DRAFT (normal preparation) and VERIFIED (a genuine later delivery)
    -- are both legitimate.
  end if;

  return new;
end;
$$;

create trigger receipts_forbid_when_locked
  before insert on public.receipts
  for each row execute function public.receipts_forbid_when_locked();

-- ============================================================
-- 4. Lock correct_document_delivery_verifier once VERIFIED
-- ============================================================
-- document_delivery_verifier_corrections is keyed to documents (the
-- source document), which can outlive many purchase_document revisions
-- -- correcting the verifier is blocked once ANY revision for that
-- source document has reached VERIFIED (a conservative rule: a genuine
-- need to correct it during an open amendment is rare and can go
-- through the same amendment/correction workflow instead).
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

  if exists (
    select 1 from public.purchase_documents
     where source_document_id = p_document_id
       and organization_id = p_organization_id
       and status = 'VERIFIED'
  ) then
    raise exception 'document % has an already-verified purchase document and its delivery verifier can no longer be corrected here', p_document_id
      using errcode = 'GA003';
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

-- ============================================================
-- 5. Completion-gate additions: delivery verifier + plausible date
-- ============================================================

-- False for a purely NON_INVENTORY document (nothing physical to
-- verify) -- driven by the CURRENT confirmed classifications, the
-- authoritative-by-submit-time signal, rather than documents.
-- declared_disposition_hint (an upload-time guess that can be wrong or
-- stale, and is never re-checked against what the lines actually
-- resolved to). A BOTH/NOT_SURE-hinted document that resolves to zero
-- CONFIRMED INVENTORY lines correctly never requires a verifier either.
create or replace function public.purchase_document_missing_delivery_verifier(
  p_purchase_document_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source_document_id uuid;
  v_has_confirmed_inventory boolean;
begin
  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  select exists (
    select 1
    from public.purchase_document_lines pdl
    join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
    where pdl.purchase_document_id = p_purchase_document_id
      and pdl.organization_id = p_organization_id
      and c.status = 'CONFIRMED'
      and c.disposition = 'INVENTORY'
  ) into v_has_confirmed_inventory;

  if not v_has_confirmed_inventory then
    return false;
  end if;

  return public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id) is null;
end;
$$;

revoke all on function public.purchase_document_missing_delivery_verifier(uuid, uuid) from public;
grant execute on function public.purchase_document_missing_delivery_verifier(uuid, uuid) to service_role;

-- A product-level plausibility rule, not a hardcoded date -- any
-- document_date before year 2000 is treated as an obviously-corrupted
-- extraction (the real case this fixes: "0002-05-29" alongside a
-- correct delivery_date of "2026-05-29"), never silently auto-corrected.
create or replace function public.purchase_document_has_implausible_date(p_document_date date)
returns boolean
language sql
immutable
as $$
  select p_document_date is not null and extract(year from p_document_date) < 2000;
$$;

-- submit_purchase_document_for_verification already exists (20260811100047)
-- with a STABLE 6-parameter signature -- body-only replace, same
-- technique as that migration's own change.
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

  return query select p_purchase_document_id, 'READY_FOR_VERIFICATION'::text, v_new_version;
end;
$$;

-- ============================================================
-- 6. verify_purchase_document: one additive check
-- ============================================================
-- The atomic reviewer-correct-and-verify path (p_header not null) is the
-- ONE remaining way a document date could change after Send for Final
-- Review already passed the plausibility check above -- so it needs the
-- identical guard here too, or a reviewer edit could reintroduce an
-- implausible date on the very same request that verifies it. Nothing
-- else in this function changes; body-only replace of the existing
-- 6-parameter signature (20260811100031's own precedent).
create or replace function public.verify_purchase_document(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_header jsonb default null,
  p_lines jsonb default null
)
returns table (
  out_purchase_document_id uuid,
  out_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_revision_group_id uuid;
  v_revision_number integer;
  v_source_document_id uuid;
  v_previous_revision_id uuid;
  v_previous_verified_by uuid;
  v_uploaded_by uuid;
  v_verified_at timestamptz;
  v_submission_event_id uuid;
  v_submitted_snapshot jsonb;
  v_submitted_header jsonb;
  v_submitted_lines jsonb;
  v_pre_header jsonb;
  v_pre_lines jsonb;
  v_post_header jsonb;
  v_post_lines jsonb;
  v_unsaved_diff jsonb;
  v_version_for_verify_check integer;
  v_final_header jsonb;
  v_final_lines jsonb;
  v_final_diff jsonb;
  v_final_correction_count integer;
  v_review_edit_count integer;
  v_reviewers jsonb;
begin
  select created_by_app_user_id, revision_group_id, revision_number, source_document_id, previous_revision_id
    into v_created_by, v_revision_group_id, v_revision_number, v_source_document_id, v_previous_revision_id
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot also verify it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  select id, after_state into v_submission_event_id, v_submitted_snapshot
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if p_header is not null then
    -- Atomic save-current-reviewer-state-and-verify. Capture the
    -- immediately-prior persisted state first so the REVIEW_CORRECTED
    -- event (if any) reports a real pre-save -> new-state diff, exactly
    -- like save_purchase_document_review_corrections's own attribution.
    select jsonb_build_object(
        'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
        'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
        'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
      )
      into v_pre_header
      from public.purchase_documents
     where id = p_purchase_document_id;

    select coalesce(jsonb_agg(jsonb_build_object(
        'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
        'package_quantity', package_quantity, 'package_unit', package_unit,
        'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
        'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
      ) order by line_number), '[]'::jsonb)
      into v_pre_lines
      from public.purchase_document_lines
     where purchase_document_id = p_purchase_document_id;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line(value)
      where line.value ->> 'lineKey' is not null
      group by line.value ->> 'lineKey'
      having count(*) > 1
    ) then
      raise exception 'duplicate line_key values in submitted lines for purchase_document %', p_purchase_document_id;
    end if;

    if public.purchase_document_has_implausible_date(public.safe_parse_date(p_header->>'documentDate')) then
      raise exception 'purchase_document % has an implausible document date %', p_purchase_document_id, p_header->>'documentDate'
        using errcode = 'GA013';
    end if;

    -- Only now, after every check above has already succeeded, enable the
    -- narrow trigger-level capability the freeze triggers require -- the
    -- row is still READY_FOR_VERIFICATION at this point, not yet VERIFIED.
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

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
       and pd.status = 'READY_FOR_VERIFICATION'
       and pd.version = p_expected_version
     returning pd.version into v_version_for_verify_check;

    if not found then
      raise exception 'purchase_document % could not be verified: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
        using errcode = 'GA002';
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

    select jsonb_build_object(
        'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
        'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
        'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
      )
      into v_post_header
      from public.purchase_documents
     where id = p_purchase_document_id;

    select coalesce(jsonb_agg(jsonb_build_object(
        'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
        'package_quantity', package_quantity, 'package_unit', package_unit,
        'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
        'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
      ) order by line_number), '[]'::jsonb)
      into v_post_lines
      from public.purchase_document_lines
     where purchase_document_id = p_purchase_document_id;

    v_unsaved_diff := public.purchase_document_diff(v_pre_header, v_pre_lines, v_post_header, v_post_lines);

    -- Never a duplicate event: if the caller's current form state is
    -- identical to what was already persisted (e.g. Save Corrections was
    -- already clicked, then Verify with the same payload), the diff is
    -- empty and no event is written here.
    if public.purchase_document_diff_count(v_unsaved_diff) > 0 then
      insert into public.audit_events (
        organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
      ) values (
        p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_REVIEW_CORRECTED', 'purchase_document', p_purchase_document_id,
        v_unsaved_diff || jsonb_build_object('submissionAuditEventId', v_submission_event_id)
      );
    end if;
  else
    -- No current-edits payload -- verify whatever is already persisted,
    -- checked against the version the caller actually holds.
    v_version_for_verify_check := p_expected_version;
  end if;

  -- The VERIFIED transition never touches a business field itself, so it
  -- never needs (and never sets) the write-capability flag -- unchanged
  -- defense-in-depth posture from before this migration. Checked against
  -- v_version_for_verify_check, never p_expected_version a second time --
  -- once the branch above has already advanced the row's real version,
  -- reusing p_expected_version here would be an artificial stale-version
  -- failure on the caller's own just-completed save.
  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = v_version_for_verify_check
   returning pd.verified_at into v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be verified: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  v_submitted_header := v_submitted_snapshot - 'lines' - 'version';
  v_submitted_lines := coalesce(v_submitted_snapshot -> 'lines', '[]'::jsonb);

  select jsonb_build_object(
      'vendor_id', vendor_id, 'document_type', document_type, 'document_number', document_number,
      'document_date', document_date, 'po_number', po_number, 'delivery_date', delivery_date,
      'subtotal', subtotal, 'tax', tax, 'fees', fees, 'total', total, 'currency', currency
    )
    into v_final_header
    from public.purchase_documents
   where id = p_purchase_document_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'line_key', line_key, 'vendor_sku', vendor_sku, 'description', description,
      'package_quantity', package_quantity, 'package_unit', package_unit,
      'measured_quantity', measured_quantity, 'measured_unit', measured_unit,
      'unit_price', unit_price, 'price_basis_unit', price_basis_unit, 'line_total', line_total
    ) order by line_number), '[]'::jsonb)
    into v_final_lines
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id;

  -- Legacy pre-2A.2.1 submissions have no line_key in their stored
  -- snapshot lines -- degrade to header-only diffing rather than guessing
  -- a line correlation that was never captured.
  if jsonb_array_length(v_submitted_lines) > 0 and not (v_submitted_lines -> 0 ? 'line_key') then
    v_final_diff := jsonb_build_object(
      'headerChanges', (public.purchase_document_diff(v_submitted_header, '[]'::jsonb, v_final_header, '[]'::jsonb) -> 'headerChanges'),
      'lineChanges', '[]'::jsonb
    );
  else
    v_final_diff := public.purchase_document_diff(v_submitted_header, v_submitted_lines, v_final_header, v_final_lines);
  end if;
  v_final_correction_count := public.purchase_document_diff_count(v_final_diff);

  select coalesce(jsonb_agg(jsonb_build_object('appUserId', actor_app_user_id, 'fieldTouchCount', field_count)), '[]'::jsonb),
         coalesce(sum(field_count), 0)
    into v_reviewers, v_review_edit_count
    from (
      select ae.actor_app_user_id, sum(public.purchase_document_diff_count(ae.after_state))::integer as field_count
        from public.audit_events ae
       where ae.entity_type = 'purchase_document'
         and ae.entity_id = p_purchase_document_id
         and ae.action = 'PURCHASE_DOCUMENT_REVIEW_CORRECTED'
         and (ae.after_state ->> 'submissionAuditEventId') = v_submission_event_id::text
       group by ae.actor_app_user_id
    ) as per_actor;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_VERIFIED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object(
      'version', p_expected_version,
      'submissionAuditEventId', v_submission_event_id,
      'finalCorrectionCount', v_final_correction_count,
      'reviewEditCount', v_review_edit_count
    )
  );

  select d.uploaded_by_app_user_id into v_uploaded_by
    from public.documents d
   where d.id = v_source_document_id;

  if v_revision_number = 1 then
    if v_final_correction_count > 0 then
      insert into public.user_notifications (
        organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
      ) values (
        p_organization_id, v_created_by, 'PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS', 'purchase_document', p_purchase_document_id,
        'Invoice verified with corrections',
        format('%s final correction(s) were made during review.', v_final_correction_count),
        jsonb_build_object(
          'finalCorrectionCount', v_final_correction_count,
          'reviewEditCount', v_review_edit_count,
          'reviewEditors', v_reviewers,
          'verifiedByAppUserId', p_app_user_id
        )
      );
    end if;
  else
    select verified_by_app_user_id into v_previous_verified_by
      from public.purchase_documents
     where id = v_previous_revision_id;

    insert into public.user_notifications (
      organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata
    )
    select p_organization_id, recipient, 'PURCHASE_DOCUMENT_AMENDMENT_VERIFIED', 'purchase_document', p_purchase_document_id,
      'Amendment verified',
      format('An amended revision (Rev %s) was verified.', v_revision_number),
      jsonb_build_object(
        'finalCorrectionCount', v_final_correction_count,
        'reviewEditCount', v_review_edit_count,
        'reviewEditors', v_reviewers,
        'verifiedByAppUserId', p_app_user_id,
        'revisionNumber', v_revision_number,
        'previousRevisionId', v_previous_revision_id
      )
    from (select distinct r as recipient from unnest(array[v_uploaded_by, v_previous_verified_by]) as r where r is not null) as recipients;
  end if;

  return query select p_purchase_document_id, v_verified_at;
end;
$$;
