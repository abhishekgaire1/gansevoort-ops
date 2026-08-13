-- Fixes a blocking product defect found during manual browser smoke testing:
-- clicking "Submit for Verification" (or "Verify"/"Verify with N
-- Corrections") persisted whatever was LAST SAVED to the database, not the
-- values visibly on screen at the moment of the click. The UI never sent
-- the current form state to these RPCs -- only purchase_document_id and
-- expected_version -- so any edit made after the last explicit Save Draft/
-- Save Corrections click was silently discarded. This affected revision 1
-- and every amendment revision identically, since both use the same
-- generic submit/verify RPCs.
--
-- Fix: submit_purchase_document_for_verification and verify_purchase_document
-- both gain two new OPTIONAL trailing parameters, p_header/p_lines
-- (default null). Every existing call that omits them (every test and any
-- other caller written before this migration) behaves EXACTLY as before --
-- pure status transition against whatever is already persisted. When the UI
-- provides them (the current on-screen form state), the RPC atomically
-- persists that state and performs the transition in the SAME transaction,
-- so there is no way to observe (or crash into) an intermediate saved-but-
-- not-yet-submitted state, and no separate client-side save call is ever
-- required before Submit/Verify.
--
-- Version semantics: each RPC call still produces exactly the same number
-- of version increments as the equivalent explicit "Save then
-- Submit/Verify" flow would have, because persisting the current form state
-- and transitioning the record are still two separate, ordered facts (a
-- save, then a transition) -- just executed as one uninterruptible
-- transaction instead of two round trips. The critical bug this design
-- deliberately avoids: the second internal step never reuses the client's
-- original p_expected_version -- it always checks against the version the
-- FIRST internal step just produced, so there is no artificial internal
-- stale-version failure.

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
    -- Atomic save-and-submit: the caller supplied the exact current form
    -- state. Lines are replaced FIRST, while the row is still DRAFT (no
    -- restriction applies to a DRAFT row's lines, so this needs no
    -- trigger-level capability flag) -- only afterward does the single
    -- header UPDATE below flip status to READY_FOR_VERIFICATION, so the
    -- lines table is never touched while its parent is already
    -- READY_FOR_VERIFICATION.
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

  -- Built from whatever is now persisted -- reflects the just-saved values
  -- above when p_header was provided, never a stale pre-click snapshot.
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
