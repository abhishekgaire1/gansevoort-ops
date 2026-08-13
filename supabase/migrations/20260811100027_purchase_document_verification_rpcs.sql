-- Milestone 2A.2: purchase document verification RPCs
--
-- submit_purchase_document_for_verification is preparer-only (same check
-- as the draft RPCs in 20260811100026) -- "I've finished correcting this,
-- it's ready for independent review" is the preparer's own attestation,
-- and it's where the completeness gates live (vendor set + active, type
-- resolved to a real value, at least one line) rather than on verify --
-- submitting an incomplete draft wastes the reviewer's time.
--
-- verify_purchase_document and return_purchase_document_to_draft are the
-- inverse: NON-preparer-only. The segregation-of-duties check compares
-- documents.uploaded_by_app_user_id (immutable, permanently fixed at
-- upload) against the acting app_user -- identity-based, not role-based,
-- so an admin who happens to be the uploader is blocked exactly like a
-- manager would be. This is safe to check as a plain read before the
-- atomic status/version UPDATE for the same reason the preparer check is:
-- uploaded_by_app_user_id can never change, so there's no race window.
--
-- All three write a durable audit_events row (reusing the existing
-- append-only table, no new one) so repeated submit/return/resubmit
-- cycles remain fully distinguishable in the audit trail, not just the
-- latest state (which the last_returned_* convenience columns on
-- purchase_documents already show, but are NOT the historical record).

-- Completeness gates + segregation-neutral (preparer may submit their own
-- draft). All gates fold into the ONE atomic UPDATE below to avoid any
-- TOCTOU window between "check complete" and "flip to READY_FOR_VERIFICATION"
-- -- e.g. without this, a concurrent save could delete every line in the
-- gap between a separate existence-check and the status flip.
create or replace function public.submit_purchase_document_for_verification(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer
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
  v_uploaded_by uuid;
  v_new_version integer;
  v_snapshot jsonb;
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
    raise exception 'app_user % is not the preparer of purchase_document % and may not submit it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
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

  -- Snapshot taken AFTER the update commits within this transaction, so it
  -- reflects the just-submitted, version-bumped row -- the complete record
  -- of what the independent reviewer is actually being asked to review,
  -- not just a line count (a line count alone can't distinguish version A
  -- of a document from version B after a return-and-resubmit cycle).
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

revoke all on function public.submit_purchase_document_for_verification(uuid, uuid, uuid, integer) from public;
grant execute on function public.submit_purchase_document_for_verification(uuid, uuid, uuid, integer) to service_role;

-- Non-preparer-only (GA004 on self-verify).
create or replace function public.verify_purchase_document(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer
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
  v_uploaded_by uuid;
  v_verified_at timestamptz;
begin
  select d.uploaded_by_app_user_id into v_uploaded_by
    from public.documents d
    join public.purchase_documents pd on pd.source_document_id = d.id and pd.organization_id = d.organization_id
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_uploaded_by = p_app_user_id then
    raise exception 'app_user % uploaded the source document for purchase_document % and cannot also verify it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.verified_at into v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be verified: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- Identifies exactly which submitted snapshot was verified: since
  -- READY_FOR_VERIFICATION is locked from all editing between submit and
  -- verify, p_expected_version equals the version the corresponding
  -- PURCHASE_DOCUMENT_SUBMITTED event recorded -- a reader can look that
  -- event up directly for "what did the verifier actually approve."
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_VERIFIED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version)
  );

  return query select p_purchase_document_id, v_verified_at;
end;
$$;

revoke all on function public.verify_purchase_document(uuid, uuid, uuid, integer) from public;
grant execute on function public.verify_purchase_document(uuid, uuid, uuid, integer) to service_role;

-- Non-preparer-only (GA004 on self-return) -- only someone eligible to
-- verify may bounce a document back, otherwise the preparer could cycle
-- DRAFT <-> READY_FOR_VERIFICATION themselves and defeat independent
-- review. Editing rights on the resulting DRAFT automatically revert to
-- the original uploader -- this falls out for free from the preparer
-- check in 20260811100026 being against the same permanently-immutable
-- documents.uploaded_by_app_user_id, not any separately-tracked "current
-- editor" state that would need its own reset logic.
create or replace function public.return_purchase_document_to_draft(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_reason text default null
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

  if v_uploaded_by = p_app_user_id then
    raise exception 'app_user % uploaded the source document for purchase_document % and cannot return it to draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  update public.purchase_documents as pd
     set status = 'DRAFT',
         last_returned_by_app_user_id = p_app_user_id,
         last_returned_reason = p_reason,
         last_returned_at = now(),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'READY_FOR_VERIFICATION'
     and pd.version = p_expected_version
   returning pd.version into v_new_version;

  if not found then
    raise exception 'purchase_document % could not be returned to draft: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  -- version here is the READY_FOR_VERIFICATION version being returned
  -- (captured in p_expected_version, before this transition bumped it) --
  -- ties this event directly back to the specific PURCHASE_DOCUMENT_SUBMITTED
  -- event it's rejecting.
  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_RETURNED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version, 'reason', p_reason)
  );

  return query select p_purchase_document_id, 'DRAFT'::text, v_new_version;
end;
$$;

revoke all on function public.return_purchase_document_to_draft(uuid, uuid, uuid, integer, text) from public;
grant execute on function public.return_purchase_document_to_draft(uuid, uuid, uuid, integer, text) to service_role;
