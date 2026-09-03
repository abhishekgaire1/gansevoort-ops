-- Fix: post_purchase_document_sole_approver (20260811100133) referenced a
-- table that doesn't exist -- public.storage_locations -- when computing
-- the "Receiving location(s)" fact for its audit event. The real table is
-- public.locations (20260811100002); receipt_lines.location_id's own FK
-- (receipt_lines_location_org_fk, 20260811100040) already confirms this.
-- Caught by tests/soleApproverPermission.rpc.test.ts against the real DEV
-- database before this ever reached a real posting. Body-only replace,
-- same signature, every other statement byte-identical to 20260811100133's
-- definition.

create or replace function public.post_purchase_document_sole_approver(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version integer,
  p_reason text,
  p_notes text,
  p_idempotency_key uuid default null
)
returns table (
  out_purchase_document_id uuid,
  out_status text,
  out_verified_at timestamptz,
  out_verification_method text,
  out_posting_status text,
  out_posting_id uuid,
  out_posted_line_count integer,
  out_movement_count integer,
  out_invoice_total numeric,
  out_inventory_value numeric,
  out_inventory_line_count integer,
  out_expense_line_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_version integer;
  v_revision_group_id uuid;
  v_document_date date;
  v_total numeric;
  v_document_number text;
  v_vendor_id uuid;
  v_new_version integer;
  v_verified_at timestamptz;
  v_inventory_value numeric;
  v_inventory_line_count integer;
  v_expense_line_count integer;
  v_actor_name text;
  v_locations jsonb;
  v_posting record;
  v_notify_error text;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required for single-manager approval' using errcode = 'GA078';
  end if;

  select status, version, revision_group_id, document_date, total, document_number, vendor_id
    into v_status, v_version, v_revision_group_id, v_document_date, v_total, v_document_number, v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if not public.has_permission(p_app_user_id, p_organization_id, 'purchase_documents.post_without_second_review') then
    raise exception 'app_user % does not have permission to post without a second reviewer', p_app_user_id
      using errcode = 'GA076';
  end if;

  if v_status <> 'DRAFT' or v_version <> p_expected_version then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has incomplete item mapping/receiving preparation', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_has_implausible_date(v_document_date) then
    raise exception 'purchase_document % has an implausible document date', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if exists (
    select 1
      from public.purchase_document_inventory_postings pip
      join public.purchase_documents sibling
        on sibling.id = pip.purchase_document_id and sibling.organization_id = p_organization_id
     where pip.organization_id = p_organization_id
       and sibling.revision_group_id = v_revision_group_id
       and sibling.id <> p_purchase_document_id
  ) then
    raise exception 'purchase_document % cannot post -- another revision in this amendment lineage has already posted inventory for this business document', p_purchase_document_id
      using errcode = 'GA075';
  end if;

  update public.purchase_documents as pd
     set status = 'VERIFIED',
         verified_by_app_user_id = p_app_user_id,
         verified_at = now(),
         verification_method = 'SOLE_APPROVER',
         sole_approver_reason = btrim(p_reason),
         sole_approver_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         version = pd.version + 1
   where pd.id = p_purchase_document_id
     and pd.organization_id = p_organization_id
     and pd.status = 'DRAFT'
     and pd.version = p_expected_version
   returning pd.version, pd.verified_at into v_new_version, v_verified_at;

  if not found then
    raise exception 'purchase_document % could not be posted as sole approver: not a DRAFT, or the version is stale', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  select
    coalesce(sum(pdl.line_total) filter (where c.disposition = 'INVENTORY'), 0),
    count(*) filter (where c.disposition = 'INVENTORY'),
    count(*) filter (where c.disposition = 'NON_INVENTORY')
    into v_inventory_value, v_inventory_line_count, v_expense_line_count
    from public.purchase_document_lines pdl
    join public.purchase_document_line_classifications c
      on c.organization_id = pdl.organization_id
     and c.purchase_document_id = pdl.purchase_document_id
     and c.line_key = pdl.line_key
   where pdl.purchase_document_id = p_purchase_document_id
     and pdl.organization_id = p_organization_id;

  -- FIX (was public.storage_locations, which does not exist): the real
  -- table is public.locations (20260811100002).
  select coalesce(jsonb_agg(distinct l.name), '[]'::jsonb)
    into v_locations
    from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
    join public.receipt_lines rl on rl.receipt_id = er.id
    join public.locations l on l.id = rl.location_id and l.organization_id = p_organization_id
   where rl.matched_line_key is not null;

  select (e.first_name || ' ' || e.last_name) into v_actor_name
    from public.app_users au
    join public.employees e on e.id = au.employee_id
   where au.id = p_app_user_id and au.organization_id = p_organization_id;

  select * into v_posting from public.post_purchase_document_inventory(p_purchase_document_id, p_organization_id, p_app_user_id);

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_POSTED_SOLE_APPROVER', 'purchase_document', p_purchase_document_id,
    jsonb_build_object(
      'purchaseDocumentId', p_purchase_document_id,
      'revisionGroupId', v_revision_group_id,
      'actorAppUserId', p_app_user_id,
      'actorName', v_actor_name,
      'permissionUsed', 'purchase_documents.post_without_second_review',
      'reason', btrim(p_reason),
      'notes', nullif(btrim(coalesce(p_notes, '')), ''),
      'occurredAt', v_verified_at,
      'invoiceTotal', v_total,
      'inventoryValue', v_inventory_value,
      'inventoryLineCount', v_inventory_line_count,
      'expenseLineCount', v_expense_line_count,
      'postingStatus', v_posting.out_status,
      'postingId', v_posting.out_posting_id,
      'postedLineCount', v_posting.out_posted_line_count,
      'movementCount', v_posting.out_movement_count,
      'idempotencyKey', p_idempotency_key,
      'vendorId', v_vendor_id,
      'documentNumber', v_document_number,
      'locations', v_locations
    )
  );

  begin
    insert into public.user_notifications (organization_id, recipient_app_user_id, type, entity_type, entity_id, title, body, metadata)
    select p_organization_id, au.id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_POSTED', 'purchase_document', p_purchase_document_id,
           'Invoice posted by sole approver',
           coalesce(v_actor_name, 'A manager') || ' posted purchase document ' || coalesce(v_document_number, p_purchase_document_id::text) ||
             ' without a second reviewer.',
           jsonb_build_object('reason', btrim(p_reason), 'invoiceTotal', v_total)
      from public.app_users au
      join public.user_roles ur on ur.app_user_id = au.id
      join public.roles r on r.id = ur.role_id and r.name = 'admin'
     where au.organization_id = p_organization_id
       and au.is_active
       and au.id <> p_app_user_id;
  exception when others then
    v_notify_error := sqlerrm;
    insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
    values (
      p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SOLE_APPROVER_NOTIFICATION_FAILED', 'purchase_document', p_purchase_document_id,
      jsonb_build_object('error', v_notify_error)
    );
  end;

  return query select
    p_purchase_document_id, 'VERIFIED'::text, v_verified_at, 'SOLE_APPROVER'::text,
    v_posting.out_status, v_posting.out_posting_id, v_posting.out_posted_line_count, v_posting.out_movement_count,
    v_total, v_inventory_value, v_inventory_line_count, v_expense_line_count;
end;
$$;

revoke all on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) from public;
grant execute on function public.post_purchase_document_sole_approver(uuid, uuid, uuid, integer, text, text, uuid) to service_role;
