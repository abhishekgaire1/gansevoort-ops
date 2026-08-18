-- Milestone 2A.4 -- review-proposal overlay lifecycle + concurrency
-- hardening (fixes the HIGH and MEDIUM findings of the final adversarial
-- review; no UI redesign, no inventory-core changes).
--
--   1. HIGH -- withdraw_purchase_document_submission now archives (into
--      the SUBMISSION_WITHDRAWN audit event) and DELETES any pending
--      reviewer-proposal overlay, exactly like Return to Preparer. A
--      stale overlay can no longer survive a withdraw -> rework ->
--      resubmit cycle.
--   2. Defense in depth -- the overlay is structurally BOUND to the
--      PURCHASE_DOCUMENT_SUBMITTED audit event it reviews
--      (submission_audit_event_id, composite-org FK). verify_purchase_
--      document refuses (GA020, consuming nothing) an overlay whose
--      binding is not the current submission, so a proposal from
--      submission A can never promote into submission B regardless of
--      which lifecycle path produced the mismatch.
--   3. Stale targets -- promotion now pre-validates EVERY proposal target
--      (mapping line_keys against current lines, receiving receipt_lines
--      against the effective receiving state) and fails the whole verify
--      (GA020) on any miss: all-or-nothing, never a silent partial
--      promotion with a consumed overlay.
--   4. MEDIUM -- optimistic concurrency on the overlay: an integer
--      version column; save_purchase_document_review_proposals takes
--      p_expected_version (0 = creating) and rejects a stale save with
--      GA018 instead of last-write-wins whole-row overwrites between
--      reviewer tabs.
--   5. Reviewer ownership -- an existing overlay belongs to the reviewer
--      who created it; a DIFFERENT reviewer's save is rejected (GA019, no
--      silent takeover; no takeover flow in this pass).
--   6. Check-then-write race -- the save RPC now locks the purchase_
--      document row FOR UPDATE before validating lifecycle, and
--      verify_purchase_document locks it at entry, so a proposal save
--      can never interleave with Final Verify / Return / Withdraw: no
--      overlay row can be created after the document leaves
--      READY_FOR_VERIFICATION.
--
-- New error codes: GA018 (review proposals changed elsewhere), GA019
-- (review proposals owned by another reviewer), GA020 (stale review
-- overlay / stale proposal target).

-- ============================================================
-- 1. audit_events composite identity target (additive) -- required so
--    the overlay's submission binding can use this schema's standard
--    composite (id, organization_id) FK pattern.
-- ============================================================
alter table public.audit_events
  add constraint audit_events_id_org_unique unique (id, organization_id);

-- ============================================================
-- 2. Overlay: submission binding + optimistic version
-- ============================================================
alter table public.purchase_document_review_proposals
  add column submission_audit_event_id uuid,
  add column version bigint not null default 1;

-- Backfill any existing overlay rows (test/dev residue) to their
-- document's current submission; rows that cannot be bound are
-- meaningless and dropped.
update public.purchase_document_review_proposals prp
   set submission_audit_event_id = (
     select ae.id
       from public.audit_events ae
      where ae.entity_type = 'purchase_document'
        and ae.entity_id = prp.purchase_document_id
        and ae.organization_id = prp.organization_id
        and ae.action = 'PURCHASE_DOCUMENT_SUBMITTED'
      order by ae.occurred_at desc
      limit 1
   );

delete from public.purchase_document_review_proposals
 where submission_audit_event_id is null;

alter table public.purchase_document_review_proposals
  alter column submission_audit_event_id set not null;

alter table public.purchase_document_review_proposals
  add constraint purchase_document_review_proposals_submission_fk
    foreign key (submission_audit_event_id, organization_id)
    references public.audit_events (id, organization_id);

-- ============================================================
-- 3. save_purchase_document_review_proposals v2 -- new signature
--    (p_expected_version), so the old 5-arg overload must go.
-- ============================================================
drop function public.save_purchase_document_review_proposals(uuid, uuid, uuid, jsonb, jsonb);

create function public.save_purchase_document_review_proposals(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_expected_version bigint,
  p_mapping_proposals jsonb default '{}'::jsonb,
  p_receiving_proposals jsonb default '{}'::jsonb
)
returns table (
  out_version bigint,
  out_mapping_count integer,
  out_receiving_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_created_by uuid;
  v_submission_event_id uuid;
  v_overlay public.purchase_document_review_proposals%rowtype;
  v_mapping jsonb := coalesce(p_mapping_proposals, '{}'::jsonb);
  v_receiving jsonb := coalesce(p_receiving_proposals, '{}'::jsonb);
  v_bad_key text;
  v_new_version bigint;
begin
  -- Lock the document row FIRST: Final Verify / Return / Withdraw all
  -- write this row, so holding its lock through the status check AND the
  -- overlay write makes the check-then-write sequence atomic against
  -- every lifecycle transition -- no overlay can be inserted after the
  -- document leaves READY_FOR_VERIFICATION.
  select status, created_by_app_user_id into v_status, v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_status <> 'READY_FOR_VERIFICATION' then
    raise exception 'purchase_document % is not in final review; reviewer proposals only exist during READY_FOR_VERIFICATION', p_purchase_document_id
      using errcode = 'GA002';
  end if;

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot propose reviewer corrections on it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
  end if;

  select id into v_submission_event_id
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if v_submission_event_id is null then
    raise exception 'purchase_document % has no submission event to bind reviewer proposals to', p_purchase_document_id;
  end if;

  -- Light shape validation (courtesy -- promotion re-validates
  -- authoritatively): mapping keys must be CURRENT line keys and target
  -- CONFIRMED items of this organization; receiving keys must be receipt
  -- lines belonging to this document's receipts.
  select key into v_bad_key
    from jsonb_each(v_mapping)
   where not exists (
           select 1 from public.purchase_document_lines pdl
            where pdl.purchase_document_id = p_purchase_document_id
              and pdl.organization_id = p_organization_id
              and pdl.line_key::text = key
         )
   limit 1;
  if v_bad_key is not null then
    raise exception 'mapping proposal targets line_key % which is not a current line of purchase_document %', v_bad_key, p_purchase_document_id;
  end if;

  select key into v_bad_key
    from jsonb_each(v_mapping)
   where not exists (
           select 1 from public.inventory_items ii
            where ii.id = (value ->> 'inventoryItemId')::uuid
              and ii.organization_id = p_organization_id
              and ii.approval_status = 'CONFIRMED'
         )
   limit 1;
  if v_bad_key is not null then
    raise exception 'mapping proposal for line_key % does not target a CONFIRMED inventory item of this organization', v_bad_key;
  end if;

  select key into v_bad_key
    from jsonb_each(v_receiving)
   where not exists (
           select 1
             from public.receipt_lines rl
             join public.receipts r on r.id = rl.receipt_id
            where rl.id::text = key
              and r.organization_id = p_organization_id
              and r.purchase_document_id = p_purchase_document_id
         )
   limit 1;
  if v_bad_key is not null then
    raise exception 'receiving proposal targets receipt_line % which does not belong to purchase_document %', v_bad_key, p_purchase_document_id;
  end if;

  select * into v_overlay
    from public.purchase_document_review_proposals
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
   for update;

  if found and v_overlay.submission_audit_event_id is distinct from v_submission_event_id then
    -- A stale-bound overlay should be impossible (Return AND Withdraw
    -- both discard it) -- but if one exists it reviews an EARLIER
    -- submission and is dead state: discard it and treat this save as a
    -- fresh creation for the current submission. The page never surfaces
    -- a stale-bound overlay, so the caller's expected version is 0 here.
    delete from public.purchase_document_review_proposals where id = v_overlay.id;
    v_overlay := null;
  end if;

  if v_overlay.id is null then
    if p_expected_version <> 0 then
      raise exception 'reviewer proposals for purchase_document % changed elsewhere (no active overlay; expected version %)', p_purchase_document_id, p_expected_version
        using errcode = 'GA018';
    end if;
    if v_mapping = '{}'::jsonb and v_receiving = '{}'::jsonb then
      return query select 0::bigint, 0, 0;
      return;
    end if;
    insert into public.purchase_document_review_proposals (
      organization_id, purchase_document_id, proposed_by_app_user_id,
      submission_audit_event_id, mapping_proposals, receiving_proposals, version
    ) values (
      p_organization_id, p_purchase_document_id, p_app_user_id,
      v_submission_event_id, v_mapping, v_receiving, 1
    );
    v_new_version := 1;
  else
    -- Reviewer ownership: no silent takeover of another reviewer's
    -- in-progress proposals (no takeover flow exists in this pass).
    if v_overlay.proposed_by_app_user_id <> p_app_user_id then
      raise exception 'reviewer proposals for purchase_document % are owned by another reviewer', p_purchase_document_id
        using errcode = 'GA019';
    end if;
    -- Optimistic concurrency: a save from stale local state (another tab
    -- already advanced the overlay) must never silently overwrite it.
    if v_overlay.version <> p_expected_version then
      raise exception 'reviewer proposals for purchase_document % changed elsewhere (version % expected, % current)', p_purchase_document_id, p_expected_version, v_overlay.version
        using errcode = 'GA018';
    end if;
    if v_mapping = '{}'::jsonb and v_receiving = '{}'::jsonb then
      delete from public.purchase_document_review_proposals where id = v_overlay.id;
      return query select 0::bigint, 0, 0;
      return;
    end if;
    update public.purchase_document_review_proposals
       set mapping_proposals = v_mapping,
           receiving_proposals = v_receiving,
           version = v_overlay.version + 1,
           updated_at = now()
     where id = v_overlay.id
     returning version into v_new_version;
  end if;

  return query select
    v_new_version,
    (select count(*) from jsonb_object_keys(v_mapping))::integer,
    (select count(*) from jsonb_object_keys(v_receiving))::integer;
end;
$$;

revoke all on function public.save_purchase_document_review_proposals(uuid, uuid, uuid, bigint, jsonb, jsonb) from public;
grant execute on function public.save_purchase_document_review_proposals(uuid, uuid, uuid, bigint, jsonb, jsonb) to service_role;

-- ============================================================
-- 4. verify_purchase_document: entry lock + freshness + stale-target
--    guards ahead of promotion
-- ============================================================
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
  v_overlay public.purchase_document_review_proposals%rowtype;
  v_proposal_key text;
  v_proposal jsonb;
  v_receipt record;
  v_correction_lines jsonb;
  v_promoted_mapping_count integer := 0;
  v_promoted_receiving_count integer := 0;
  v_stale_proposal_key text;
begin
  -- FOR UPDATE: every reviewer-proposal save locks this same row before
  -- validating lifecycle, so a save can never interleave between this
  -- transaction's overlay read and its VERIFIED transition (and vice
  -- versa a verify can never land between a save's status check and its
  -- overlay write).
  select created_by_app_user_id, revision_group_id, revision_number, source_document_id, previous_revision_id
    into v_created_by, v_revision_group_id, v_revision_number, v_source_document_id, v_previous_revision_id
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id
   for update;

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

  -- ============================================================
  -- Promote Manager 2's pending correction proposals (if any).
  -- This is the ONLY point where reviewer proposals become
  -- authoritative: until here they live in
  -- purchase_document_review_proposals as explicitly-provisional
  -- review state (persisted != authoritative), and the reviewer
  -- windows in record_receipt / approve_line_classification_* open
  -- only under the transaction-local promotion flag set below --
  -- so no reviewer correction can be applied outside this path.
  -- Everything runs in this same transaction: a failure of any
  -- promotion step or of the authoritative gates below rolls ALL
  -- of it back, leaving the submitted/effective state untouched.
  -- ============================================================
  select * into v_overlay
    from public.purchase_document_review_proposals
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
   for update;

  if found then
    -- STRUCTURAL freshness: the overlay is bound at creation to the
    -- PURCHASE_DOCUMENT_SUBMITTED event it reviews. A proposal from
    -- submission A can NEVER promote into submission B -- whatever
    -- READY->DRAFT->READY path produced the mismatch, promotion refuses
    -- and consumes nothing.
    if v_overlay.submission_audit_event_id is distinct from v_submission_event_id then
      raise exception 'reviewer proposals for purchase_document % belong to an earlier submission and cannot be promoted -- reload the current review', p_purchase_document_id
        using errcode = 'GA020';
    end if;

    -- Every proposal target must resolve against the CURRENT state of
    -- this same submission. All-or-nothing: one stale target fails the
    -- whole verify (overlay untouched, for reviewer recovery) -- never a
    -- silent partial promotion.
    select key into v_stale_proposal_key
      from jsonb_object_keys(coalesce(v_overlay.mapping_proposals, '{}'::jsonb)) as key
     where not exists (
             select 1 from public.purchase_document_lines pdl
              where pdl.purchase_document_id = p_purchase_document_id
                and pdl.organization_id = p_organization_id
                and pdl.line_key::text = key
           )
     limit 1;
    if v_stale_proposal_key is not null then
      raise exception 'reviewer mapping proposal for purchase_document % targets line_key %, which is no longer a current line -- reload the current review', p_purchase_document_id, v_stale_proposal_key
        using errcode = 'GA020';
    end if;

    select key into v_stale_proposal_key
      from jsonb_object_keys(coalesce(v_overlay.receiving_proposals, '{}'::jsonb)) as key
     where not exists (
             select 1
               from public.receipt_lines rl
               join public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
                 on er.id = rl.receipt_id
              where rl.id::text = key
           )
     limit 1;
    if v_stale_proposal_key is not null then
      raise exception 'reviewer receiving proposal for purchase_document % targets receipt_line %, which is no longer part of the effective receiving state -- reload the current review', p_purchase_document_id, v_stale_proposal_key
        using errcode = 'GA020';
    end if;

    perform set_config('gansevoort.purchase_document_review_promotion', 'true', true);

    -- 2a. Item-resolution proposals FIRST: the reviewer's corrected line
    -- facts were persisted above, so re-confirmation resolves against the
    -- CORRECTED facts (never the stale pre-correction ones) -- this is
    -- also what lets an identity-field correction plus a mapping proposal
    -- verify coherently in one click. Reuses the audited approval RPC
    -- (LINE_CLASSIFICATION_CONFIRMED, duplicate-name and org rules)
    -- rather than a competing write path.
    for v_proposal_key, v_proposal in
      select key, value from jsonb_each(coalesce(v_overlay.mapping_proposals, '{}'::jsonb))
    loop
      perform public.approve_line_classification_existing_item(
        p_purchase_document_id => p_purchase_document_id,
        p_line_key => v_proposal_key::uuid,
        p_organization_id => p_organization_id,
        p_app_user_id => p_app_user_id,
        p_inventory_item_id => (v_proposal ->> 'inventoryItemId')::uuid,
        p_remember_vendor_mapping => coalesce((v_proposal ->> 'rememberVendorMapping')::boolean, false)
      );
      v_promoted_mapping_count := v_promoted_mapping_count + 1;
    end loop;

    -- 2b. Receiving proposals: one append-only CORRECTION per affected
    -- EFFECTIVE receipt, carrying that receipt's COMPLETE corrected line
    -- set (same rule as Edit Receiving -- a partial set would silently
    -- drop the receipt's other lines). Original receipts are never
    -- mutated or deleted; record_receipt re-validates FIXED_CONVERSION
    -- math (GA015) against the item's now-current configuration.
    for v_receipt in
      select er.id
        from public.effective_receipts_for_purchase_document(p_purchase_document_id, p_organization_id) er
       where exists (
               select 1 from public.receipt_lines rl
                where rl.receipt_id = er.id
                  and coalesce(v_overlay.receiving_proposals, '{}'::jsonb) ? rl.id::text
             )
       order by er.occurred_at, er.id
    loop
      select jsonb_agg(jsonb_build_object(
               'lineNumberSnapshot', rl.line_number_snapshot,
               'matchedLineKey', rl.matched_line_key,
               'vendorSkuSnapshot', rl.vendor_sku_snapshot,
               'descriptionSnapshot', rl.description_snapshot,
               'invoicePackageQuantity', rl.invoice_package_quantity,
               'invoicePackageUnit', rl.invoice_package_unit,
               'invoiceMeasuredQuantity', rl.invoice_measured_quantity,
               'invoiceMeasuredUnit', rl.invoice_measured_unit,
               'actualReceivedPackageQuantity',
                 case when ov.p is not null then (ov.p ->> 'receivedQuantity')::numeric
                      else rl.actual_received_package_quantity end,
               'actualReceivedPackageUnit',
                 case when ov.p is not null then ov.p ->> 'receivedUnit'
                      else rl.actual_received_package_unit end,
               'actualVerifiedBaseQuantity',
                 case when ov.p is not null then (ov.p ->> 'verifiedBaseQuantity')::numeric
                      else rl.actual_verified_base_quantity end,
               -- The base unit itself never changes by editing quantities
               -- (same rule as Edit Receiving); cleared when the verified
               -- quantity is cleared.
               'actualVerifiedBaseUnitId',
                 case when (case when ov.p is not null then (ov.p ->> 'verifiedBaseQuantity')::numeric
                                 else rl.actual_verified_base_quantity end) is not null
                      then rl.actual_verified_base_unit_id else null end,
               'locationId',
                 case when ov.p is not null then (ov.p ->> 'locationId')::uuid
                      else rl.location_id end,
               'conditionStatus',
                 case when ov.p is not null then coalesce(ov.p ->> 'conditionStatus', rl.condition_status)
                      else rl.condition_status end,
               'notes', rl.notes
             ) order by rl.created_at)
        into v_correction_lines
        from public.receipt_lines rl
        left join lateral (select v_overlay.receiving_proposals -> rl.id::text as p) ov on true
       where rl.receipt_id = v_receipt.id;

      perform public.record_receipt(
        p_organization_id => p_organization_id,
        p_app_user_id => p_app_user_id,
        p_receipt_kind => 'CORRECTION',
        p_corrects_receipt_id => v_receipt.id,
        p_lines => v_correction_lines,
        p_idempotency_key => 'review-promotion:' || v_receipt.id
      );
      v_promoted_receiving_count := v_promoted_receiving_count + 1;
    end loop;

    -- The proposals now exist as real audited state (the approval events
    -- and CORRECTION receipts written above) -- the provisional overlay
    -- row is spent.
    delete from public.purchase_document_review_proposals
     where id = v_overlay.id;
  end if;

  -- AUTHORITATIVE re-validation of the POST-correction state -- the same
  -- gates Send for Final Review enforced, re-run here because reviewer
  -- corrections (header/line payload above, receiving/classification
  -- corrections during review) can invalidate completeness after Send
  -- already passed. A failing check leaves the document in final review
  -- with the exact reason; nothing is partially verified.
  if public.purchase_document_preparation_incomplete(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has incomplete item mapping/receiving preparation and cannot be verified until it is resolved', p_purchase_document_id
      using errcode = 'GA013';
  end if;

  if public.purchase_document_missing_delivery_verifier(p_purchase_document_id, p_organization_id) then
    raise exception 'purchase_document % has one or more inventory lines but no delivery verifier recorded', p_purchase_document_id
      using errcode = 'GA013';
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
      'reviewEditCount', v_review_edit_count,
      'promotedMappingCorrectionCount', v_promoted_mapping_count,
      'promotedReceivingCorrectionCount', v_promoted_receiving_count
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

revoke all on function public.verify_purchase_document(uuid, uuid, uuid, integer, jsonb, jsonb) from public;
grant execute on function public.verify_purchase_document(uuid, uuid, uuid, integer, jsonb, jsonb) to service_role;

-- ============================================================
-- 5. withdraw_purchase_document_submission: archive + discard overlay
-- ============================================================
create or replace function public.withdraw_purchase_document_submission(
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
  v_created_by uuid;
  v_new_version integer;
  v_submitted_snapshot jsonb;
  v_submitted_header jsonb;
  v_submitted_lines jsonb;
  v_overlay public.purchase_document_review_proposals%rowtype;
  v_overlay_note jsonb := '{}'::jsonb;
begin
  select created_by_app_user_id into v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_created_by is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not withdraw it', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  select after_state into v_submitted_snapshot
    from public.audit_events
   where entity_type = 'purchase_document'
     and entity_id = p_purchase_document_id
     and action = 'PURCHASE_DOCUMENT_SUBMITTED'
   order by occurred_at desc
   limit 1;

  if v_submitted_snapshot is null then
    raise exception 'purchase_document % has no submission snapshot to restore', p_purchase_document_id;
  end if;

  v_submitted_header := v_submitted_snapshot - 'lines' - 'version';
  v_submitted_lines := coalesce(v_submitted_snapshot -> 'lines', '[]'::jsonb);

  perform set_config('gansevoort.purchase_document_ready_write', 'true', true);

  update public.purchase_documents as pd
     set status = 'DRAFT',
         vendor_id = (v_submitted_header->>'vendor_id')::uuid,
         document_type = v_submitted_header->>'document_type',
         document_number = v_submitted_header->>'document_number',
         document_date = (v_submitted_header->>'document_date')::date,
         po_number = v_submitted_header->>'po_number',
         delivery_date = (v_submitted_header->>'delivery_date')::date,
         subtotal = (v_submitted_header->>'subtotal')::numeric,
         tax = (v_submitted_header->>'tax')::numeric,
         fees = (v_submitted_header->>'fees')::numeric,
         total = (v_submitted_header->>'total')::numeric,
         currency = v_submitted_header->>'currency',
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
    raise exception 'purchase_document % could not be withdrawn: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
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
    coalesce((ord.line_json->>'line_key')::uuid, gen_random_uuid()),
    ord.line_json->>'vendor_sku', ord.line_json->>'description',
    (ord.line_json->>'package_quantity')::numeric, ord.line_json->>'package_unit',
    (ord.line_json->>'measured_quantity')::numeric, ord.line_json->>'measured_unit',
    (ord.line_json->>'unit_price')::numeric, ord.line_json->>'price_basis_unit',
    (ord.line_json->>'line_total')::numeric
  from (
    select value as line_json, row_number() over () as idx
    from jsonb_array_elements(v_submitted_lines)
  ) as ord;

  -- Any pending Manager 2 proposal overlay belongs to the submission
  -- being withdrawn -- it must NOT survive into the reworked draft's next
  -- submission (a stale proposal silently promoting at the next Final
  -- Verify was the exact bug). Preserved for traceability in this audit
  -- event, then discarded -- same rule as Return to Preparer.
  select * into v_overlay
    from public.purchase_document_review_proposals
   where organization_id = p_organization_id
     and purchase_document_id = p_purchase_document_id
   for update;

  if found then
    v_overlay_note := jsonb_build_object(
      'unpromotedReviewerProposals', jsonb_build_object(
        'proposedByAppUserId', v_overlay.proposed_by_app_user_id,
        'mappingProposals', v_overlay.mapping_proposals,
        'receivingProposals', v_overlay.receiving_proposals
      )
    );
    delete from public.purchase_document_review_proposals
     where id = v_overlay.id;
  end if;

  insert into public.audit_events (
    organization_id, actor_app_user_id, action, entity_type, entity_id, after_state
  ) values (
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_SUBMISSION_WITHDRAWN', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version, 'reason', p_reason) || v_overlay_note
  );

  return query select p_purchase_document_id, 'DRAFT'::text, v_new_version;
end;
$$;

revoke all on function public.withdraw_purchase_document_submission(uuid, uuid, uuid, integer, text) from public;
grant execute on function public.withdraw_purchase_document_submission(uuid, uuid, uuid, integer, text) to service_role;
