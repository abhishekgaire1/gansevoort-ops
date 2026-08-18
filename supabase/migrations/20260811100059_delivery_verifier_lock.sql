-- Adversarial-review fix, priority 4.
--
-- correct_document_delivery_verifier (20260811100056) only blocked once
-- the source document had an already-VERIFIED purchase document -- unlike
-- every sibling preparation-mutation table that same migration locks
-- (purchase_document_line_classifications, purchase_document_line_
-- invoice_unit_confirmations, receipts CORRECTION), it had no
-- READY_FOR_VERIFICATION gate at all. Combined with Step4ReviewSend.tsx's
-- "Set Delivery Verifier" control never receiving an editable/readOnly
-- prop, the ORIGINAL PREPARER could reopen their own already-submitted
-- (READY_FOR_VERIFICATION) document, navigate to its own Step 4, and
-- silently correct the delivery verifier while Manager 2 was mid-review
-- -- confirmed reachable through normal navigation, not just devtools.
--
-- Unlike the classification writers fixed in 20260811100057/100058, this
-- correction has NO legitimate system/trusted-write exception: the
-- business rule is unconditional -- "any legitimate correction after
-- submission must happen through Return to Preparer -> DRAFT -> Manager 1
-- corrects -> Send again," never a direct mid-review edit by anyone. So
-- no gansevoort.purchase_document_ready_write flag is involved here at
-- all; DRAFT is the only status this RPC accepts going forward.
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

  -- Unchanged from 20260811100056: once ANY revision for this source
  -- document has ever reached VERIFIED, correcting the verifier here is
  -- blocked forever (a conservative rule -- a genuine need to correct it
  -- afterward goes through the amendment/correction workflow instead,
  -- never this RPC).
  if exists (
    select 1 from public.purchase_documents
     where source_document_id = p_document_id
       and organization_id = p_organization_id
       and status = 'VERIFIED'
  ) then
    raise exception 'document % has an already-verified purchase document and its delivery verifier can no longer be corrected here', p_document_id
      using errcode = 'GA003';
  end if;

  -- New: the missing gate this migration adds -- Manager 2's review
  -- window (READY_FOR_VERIFICATION) must be a stable snapshot, exactly
  -- like every other preparation-mutating table 20260811100056 already
  -- locks during review. Any legitimate correction after submission goes
  -- through Return to Preparer -> DRAFT -> Manager 1 corrects -> Send
  -- again -- there is no trusted-write exception for this RPC at all.
  if exists (
    select 1 from public.purchase_documents
     where source_document_id = p_document_id
       and organization_id = p_organization_id
       and status = 'READY_FOR_VERIFICATION'
  ) then
    raise exception 'document % has a purchase document ready for verification and its delivery verifier cannot be corrected mid-review', p_document_id
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

revoke all on function public.correct_document_delivery_verifier(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.correct_document_delivery_verifier(uuid, uuid, uuid, uuid, text) to service_role;
