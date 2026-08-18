-- Milestone 2A.4 -- Manager 2 reviewer corrections become a PROVISIONAL
-- CORRECTION OVERLAY, promoted only by Final Verify (user-directed
-- integrity correction to 20260811100070).
--
-- CORE RULE: Manager 1 submitted snapshot + Manager 2 proposed
-- corrections = review working state; ONLY Final Verify promotes the
-- reviewed corrected state into the VERIFIED authoritative state.
-- Persisted != authoritative: proposals survive refresh but carry
-- explicit review/pending semantics.
--
-- What 20260811100070 got wrong: it opened direct reviewer windows in
-- record_receipt / approve_line_classification_* during
-- READY_FOR_VERIFICATION, so a reviewer receiving edit (72 -> 70) or
-- mapping change became authoritative the moment the reviewer typed it
-- -- while header/line edits stayed provisional. Different fields had
-- different authority semantics; a reviewer who then chose Return to
-- Preparer had already changed authoritative state.
--
-- This migration:
--   1. purchase_document_review_proposals -- one mutable provisional row
--      per in-review document holding Manager 2's mapping + receiving
--      proposals (jsonb). Like purchase_document_classification_runs,
--      this is deliberately NOT append-only and never gets
--      forbid_update_delete(): it is provisional working state, not a
--      historical business fact. The durable record of an accepted
--      correction is the audited approval event / CORRECTION receipt
--      written at promotion; an unpromoted proposal is preserved inside
--      the PURCHASE_DOCUMENT_RETURNED audit event, then discarded.
--      (Header/line invoice-fact proposals need no new storage: the
--      current purchase_documents/purchase_document_lines rows during
--      READY_FOR_VERIFICATION already ARE the reviewer working copy --
--      save_purchase_document_review_corrections persists them, the
--      SUBMITTED audit snapshot preserves Manager 1's state, and Return
--      restores that snapshot wholesale.)
--   2. save_purchase_document_review_proposals -- upsert RPC, reviewer
--      (non-preparer, GA004) during READY_FOR_VERIFICATION only.
--   3. record_receipt / approve_line_classification_existing_item /
--      approve_line_classification_new_item -- the 100070 reviewer
--      windows now additionally require the transaction-local
--      gansevoort.purchase_document_review_promotion flag, which ONLY
--      verify_purchase_document sets. Direct reviewer writes during
--      final review are rejected again (GA003); DRAFT and preparer
--      (GA004/GA006) behavior unchanged; VERIFIED/DISCARDED stay locked.
--   4. verify_purchase_document -- after persisting the reviewer's
--      header/line payload and BEFORE the authoritative completeness
--      gates, promotes the overlay atomically: mapping proposals through
--      the audited approval RPC (against the just-persisted corrected
--      facts -- so an identity-field correction plus a mapping proposal
--      verifies coherently in one click), then receiving proposals as
--      append-only CORRECTION receipts through record_receipt, then the
--      gates run on the fully-promoted state. Any failure rolls the
--      entire promotion back. The VERIFIED audit event now also records
--      promoted-proposal counts.
--   5. return_purchase_document_to_draft -- embeds any unpromoted
--      proposals into the PURCHASE_DOCUMENT_RETURNED audit event and
--      deletes the overlay row; the snapshot restore is unchanged.

-- ============================================================
-- 1. Provisional reviewer-proposal overlay
-- ============================================================
create table public.purchase_document_review_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  purchase_document_id uuid not null,
  proposed_by_app_user_id uuid not null,
  -- { "<line_key>": { "inventoryItemId": "<uuid>" } }
  mapping_proposals jsonb not null default '{}'::jsonb,
  -- { "<receipt_line_id>": { "receivedQuantity": n, "receivedUnit": s|null,
  --   "verifiedBaseQuantity": n|null, "locationId": "<uuid>"|null,
  --   "conditionStatus": s } }
  receiving_proposals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, purchase_document_id),
  foreign key (purchase_document_id, organization_id)
    references public.purchase_documents (id, organization_id),
  foreign key (proposed_by_app_user_id, organization_id)
    references public.app_users (id, organization_id)
);

alter table public.purchase_document_review_proposals enable row level security;

-- ============================================================
-- 2. save_purchase_document_review_proposals
-- ============================================================
create or replace function public.save_purchase_document_review_proposals(
  p_purchase_document_id uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_mapping_proposals jsonb default '{}'::jsonb,
  p_receiving_proposals jsonb default '{}'::jsonb
)
returns table (
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
  v_mapping jsonb := coalesce(p_mapping_proposals, '{}'::jsonb);
  v_receiving jsonb := coalesce(p_receiving_proposals, '{}'::jsonb);
  v_bad_key text;
begin
  select status, created_by_app_user_id into v_status, v_created_by
    from public.purchase_documents
   where id = p_purchase_document_id
     and organization_id = p_organization_id;

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

  if v_mapping = '{}'::jsonb and v_receiving = '{}'::jsonb then
    delete from public.purchase_document_review_proposals
     where organization_id = p_organization_id
       and purchase_document_id = p_purchase_document_id;
    return query select 0, 0;
    return;
  end if;

  insert into public.purchase_document_review_proposals as prp (
    organization_id, purchase_document_id, proposed_by_app_user_id,
    mapping_proposals, receiving_proposals
  ) values (
    p_organization_id, p_purchase_document_id, p_app_user_id, v_mapping, v_receiving
  )
  on conflict (organization_id, purchase_document_id) do update
    set mapping_proposals = excluded.mapping_proposals,
        receiving_proposals = excluded.receiving_proposals,
        proposed_by_app_user_id = excluded.proposed_by_app_user_id,
        updated_at = now();

  return query select
    (select count(*) from jsonb_object_keys(v_mapping))::integer,
    (select count(*) from jsonb_object_keys(v_receiving))::integer;
end;
$$;

revoke all on function public.save_purchase_document_review_proposals(uuid, uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.save_purchase_document_review_proposals(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- ============================================================
-- 3. Tightened reviewer windows (promotion-flag required)
-- ============================================================
create or replace function public.record_receipt(
  p_organization_id uuid,
  p_app_user_id uuid,
  p_receipt_kind text,
  p_purchase_document_id uuid default null,
  p_corrects_receipt_id uuid default null,
  p_default_location_id uuid default null,
  p_notes text default null,
  p_lines jsonb default '[]'::jsonb,
  p_idempotency_key text default null
)
returns table (
  out_receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_doc_status text;
  v_doc_created_by uuid;
  v_effective_pd_id uuid;
  v_source_document_id uuid;
  v_verifier uuid;
  v_existing_receipt_id uuid;
  v_line jsonb;
  v_matched_line_key uuid;
  v_classification record;
  v_received_qty numeric;
  v_received_unit text;
  v_client_verified_qty numeric;
  v_server_verified_qty numeric;
  v_server_verified_unit_id uuid;
begin
  if p_receipt_kind not in ('DELIVERY', 'CORRECTION') then
    raise exception 'invalid receipt_kind %', p_receipt_kind;
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_receipt_id
      from public.receipts
     where organization_id = p_organization_id
       and idempotency_key = p_idempotency_key;

    if found then
      -- A genuine replay of an already-recorded request -- return the
      -- SAME receipt, insert nothing new.
      return query select v_existing_receipt_id;
      return;
    end if;
  end if;

  if p_receipt_kind = 'CORRECTION' then
    if p_corrects_receipt_id is null then
      raise exception 'corrects_receipt_id is required for a CORRECTION receipt';
    end if;

    select purchase_document_id into v_effective_pd_id
      from public.receipts
     where id = p_corrects_receipt_id and organization_id = p_organization_id;

    if not found then
      raise exception 'receipt % not found', p_corrects_receipt_id
        using errcode = 'GA012';
    end if;

    -- Reviewer receiving-correction window: during READY_FOR_VERIFICATION
    -- a CORRECTION is the sanctioned Manager 2 path -- but never for the
    -- preparer (the same no-self-review rule as verify itself), and the
    -- trigger capability is granted only here, so VERIFIED/DISCARDED
    -- corrections remain blocked exactly as before.
    select status, created_by_app_user_id into v_doc_status, v_doc_created_by
      from public.purchase_documents
     where id = v_effective_pd_id and organization_id = p_organization_id;

    if v_doc_status = 'READY_FOR_VERIFICATION' then
      if v_doc_created_by = p_app_user_id then
        raise exception 'app_user % prepared purchase_document % and cannot review-correct its receiving', p_app_user_id, v_effective_pd_id
          using errcode = 'GA004';
      end if;
      -- Reviewer receiving corrections are PROPOSALS
      -- (purchase_document_review_proposals) promoted atomically by
      -- Final Verify -- the only caller that sets this transaction-local
      -- promotion flag. A direct correction during final review, even by
      -- the legitimate reviewer, must never become authoritative on its
      -- own.
      if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
        raise exception 'purchase_document % is in final review: reviewer receiving corrections are proposals applied atomically by Final Verify, never direct writes', v_effective_pd_id
          using errcode = 'GA003';
      end if;
      perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
    end if;
  else
    if p_purchase_document_id is null then
      raise exception 'purchase_document_id is required for a DELIVERY receipt';
    end if;

    if not exists (select 1 from public.purchase_documents where id = p_purchase_document_id and organization_id = p_organization_id) then
      raise exception 'purchase_document % not found', p_purchase_document_id
        using errcode = 'GA012';
    end if;

    v_effective_pd_id := p_purchase_document_id;
  end if;

  select source_document_id into v_source_document_id
    from public.purchase_documents
   where id = v_effective_pd_id;

  v_verifier := public.current_document_delivery_verifier_employee_id(v_source_document_id, p_organization_id);

  v_receipt_id := gen_random_uuid();

  begin
    insert into public.receipts (
      id, organization_id, purchase_document_id, receipt_kind, corrects_receipt_id,
      default_location_id, delivery_verified_by_employee_id_snapshot, recorded_by_app_user_id, notes, idempotency_key
    ) values (
      v_receipt_id, p_organization_id, v_effective_pd_id, p_receipt_kind, p_corrects_receipt_id,
      p_default_location_id, v_verifier, p_app_user_id, p_notes, p_idempotency_key
    );
  exception when unique_violation then
    -- Lost a genuine race against another caller using the same key --
    -- the winner's row is now visible; return it rather than erroring.
    if p_idempotency_key is not null then
      select id into v_existing_receipt_id
        from public.receipts
       where organization_id = p_organization_id
         and idempotency_key = p_idempotency_key;
      if found then
        return query select v_existing_receipt_id;
        return;
      end if;
    end if;
    raise;
  end;

  -- FIXED_CONVERSION integrity: recompute/validate each line's verified
  -- base quantity server-side, per line, rather than trusting the
  -- client's math. SAME_UNIT/MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY
  -- lines (no resolvable purchase-unit conversion row) fall through
  -- completely untouched.
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as t(value)
  loop
    v_matched_line_key := nullif(v_line ->> 'matchedLineKey', '')::uuid;
    v_server_verified_qty := null;
    v_server_verified_unit_id := null;

    if v_matched_line_key is not null then
      select ii.base_unit_id, bu.code as base_unit_code,
             pu.code as purchase_unit_code, piu.conversion_factor
        into v_classification
        from public.purchase_document_line_classifications c
        join public.inventory_items ii on ii.id = c.inventory_item_id and ii.organization_id = c.organization_id
        join public.units bu on bu.id = ii.base_unit_id
        left join public.inventory_item_units piu
          on piu.inventory_item_id = ii.id and piu.unit_id <> ii.base_unit_id and piu.requires_actual_measurement = false
        left join public.units pu on pu.id = piu.unit_id
       where c.purchase_document_id = v_effective_pd_id
         and c.organization_id = p_organization_id
         and c.line_key = v_matched_line_key
         and c.status = 'CONFIRMED'
         and c.disposition = 'INVENTORY';

      if found and v_classification.purchase_unit_code is not null and v_classification.conversion_factor is not null then
        v_received_qty := (v_line ->> 'actualReceivedPackageQuantity')::numeric;
        v_received_unit := v_line ->> 'actualReceivedPackageUnit';
        v_client_verified_qty := nullif(v_line ->> 'actualVerifiedBaseQuantity', '')::numeric;

        if v_received_qty is not null and v_received_unit is not null then
          if lower(btrim(v_received_unit)) = lower(btrim(v_classification.purchase_unit_code)) then
            v_server_verified_qty := v_received_qty * v_classification.conversion_factor;
          elsif lower(btrim(v_received_unit)) = lower(btrim(v_classification.base_unit_code)) then
            v_server_verified_qty := v_received_qty;
          else
            raise exception 'line % received unit "%" does not match the item''s purchase unit (%) or base unit (%) -- cannot verify a FIXED_CONVERSION quantity',
              v_matched_line_key, v_received_unit, v_classification.purchase_unit_code, v_classification.base_unit_code
              using errcode = 'GA015';
          end if;

          if v_client_verified_qty is not null and v_client_verified_qty <> v_server_verified_qty then
            raise exception 'line % verified quantity % is inconsistent with % % at 1 % = % % -- expected %',
              v_matched_line_key, v_client_verified_qty, v_received_qty, v_received_unit,
              v_classification.purchase_unit_code, v_classification.conversion_factor, v_classification.base_unit_code, v_server_verified_qty
              using errcode = 'GA015';
          end if;

          v_server_verified_unit_id := v_classification.base_unit_id;
        end if;
      end if;
    end if;

    insert into public.receipt_lines (
      id, receipt_id, organization_id, line_number_snapshot, matched_line_key,
      vendor_sku_snapshot, description_snapshot,
      invoice_package_quantity, invoice_package_unit, invoice_measured_quantity, invoice_measured_unit,
      actual_received_package_quantity, actual_received_package_unit,
      actual_verified_base_quantity, actual_verified_base_unit_id,
      location_id, condition_status, notes
    ) values (
      gen_random_uuid(), v_receipt_id, p_organization_id,
      (v_line ->> 'lineNumberSnapshot')::integer,
      v_matched_line_key,
      v_line ->> 'vendorSkuSnapshot', v_line ->> 'descriptionSnapshot',
      (v_line ->> 'invoicePackageQuantity')::numeric, v_line ->> 'invoicePackageUnit',
      (v_line ->> 'invoiceMeasuredQuantity')::numeric, v_line ->> 'invoiceMeasuredUnit',
      (v_line ->> 'actualReceivedPackageQuantity')::numeric, v_line ->> 'actualReceivedPackageUnit',
      -- FIXED_CONVERSION lines: always the server's own recomputed value
      -- (never the raw client one, even when it agreed). Every other
      -- line: passed through exactly as submitted, unchanged.
      coalesce(v_server_verified_qty, (v_line ->> 'actualVerifiedBaseQuantity')::numeric),
      coalesce(v_server_verified_unit_id, (v_line ->> 'actualVerifiedBaseUnitId')::uuid),
      (v_line ->> 'locationId')::uuid,
      coalesce(v_line ->> 'conditionStatus', 'RECEIVED_AS_INVOICED'),
      v_line ->> 'notes'
    );
  end loop;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'RECEIPT_RECORDED', 'purchase_document', v_effective_pd_id,
    jsonb_build_object(
      'receiptId', v_receipt_id, 'receiptKind', p_receipt_kind, 'correctsReceiptId', p_corrects_receipt_id,
      'deliveryVerifiedByEmployeeId', v_verifier
    ));

  return query select v_receipt_id;
end;
$$;

create or replace function public.approve_line_classification_existing_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_inventory_item_id uuid,
  p_remember_vendor_mapping boolean default true
)
returns table (
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_item record;
  v_vendor_id uuid;
  v_classification_id uuid;
  v_purchase_document record;
begin
  select status, created_by_app_user_id into v_purchase_document
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_purchase_document.status = 'DRAFT' and v_purchase_document.created_by_app_user_id is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not approve item classifications on its draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  -- Reviewer item-resolution window: during READY_FOR_VERIFICATION the
  -- NON-preparer reviewing manager may correct a line's mapping (same
  -- audit events, duplicate-name guard, and vendor-memory rules as any
  -- approval); the preparer is rejected -- no self-review. The trigger
  -- capability is granted only for this window, so VERIFIED/DISCARDED
  -- stay locked exactly as before.
  if v_purchase_document.status = 'READY_FOR_VERIFICATION' then
    if v_purchase_document.created_by_app_user_id = p_app_user_id then
      raise exception 'app_user % prepared purchase_document % and cannot review-correct its item resolution', p_app_user_id, p_purchase_document_id
        using errcode = 'GA004';
    end if;
    -- Reviewer item-resolution corrections are PROPOSALS
    -- (purchase_document_review_proposals) promoted atomically by Final
    -- Verify -- the only caller that sets this transaction-local
    -- promotion flag. A direct approval during final review, even by the
    -- legitimate reviewer, must never become authoritative on its own.
    if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
      raise exception 'purchase_document % is in final review: reviewer item-resolution corrections are proposals applied atomically by Final Verify, never direct writes', p_purchase_document_id
        using errcode = 'GA003';
    end if;
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
  end if;

  select vendor_sku, description, package_unit, measured_unit
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;

  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  select id, disposition, spend_category_id into v_item
    from public.inventory_items
   where id = p_inventory_item_id
     and organization_id = p_organization_id
     and approval_status = 'CONFIRMED';

  if not found then
    raise exception 'inventory_item % is not a confirmed Item Master entry', p_inventory_item_id
      using errcode = 'GA009';
  end if;

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, v_item.disposition,
    v_item.id, v_item.spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  if p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item.id, p_app_user_id
      );
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item.id, p_app_user_id
      );
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item.id, 'newItem', false));

  return query select v_classification_id;
end;
$$;

create or replace function public.approve_line_classification_new_item(
  p_purchase_document_id uuid,
  p_line_key uuid,
  p_organization_id uuid,
  p_app_user_id uuid,
  p_final_name text,
  p_disposition text,
  p_category_id uuid,
  p_spend_category_id uuid,
  p_base_unit_code text,
  p_pending_item_id uuid default null,
  p_remember_vendor_mapping boolean default true,
  p_purchase_unit_code text default null,
  p_receiving_behavior text default null,
  p_fixed_conversion_factor numeric default null
)
returns table (
  out_inventory_item_id uuid,
  out_classification_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_base_unit_id uuid;
  v_purchase_unit_id uuid;
  v_line record;
  v_classification_id uuid;
  v_vendor_id uuid;
  v_purchase_document record;
  v_duplicate record;
begin
  if p_disposition not in ('INVENTORY', 'NON_INVENTORY') then
    raise exception 'invalid disposition %', p_disposition;
  end if;

  if p_spend_category_id is null then
    raise exception 'a spend category is required to confirm a new item' using errcode = 'GA013';
  end if;

  if p_receiving_behavior is not null and p_receiving_behavior not in
    ('SAME_UNIT', 'FIXED_CONVERSION', 'MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
  then
    raise exception 'invalid receiving behavior %', p_receiving_behavior;
  end if;

  select status, created_by_app_user_id into v_purchase_document
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if not found then
    raise exception 'purchase_document % not found', p_purchase_document_id;
  end if;

  if v_purchase_document.status = 'DRAFT' and v_purchase_document.created_by_app_user_id is distinct from p_app_user_id then
    raise exception 'app_user % is not the preparer of purchase_document % and may not approve item classifications on its draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA006';
  end if;

  -- Reviewer item-resolution window: during READY_FOR_VERIFICATION the
  -- NON-preparer reviewing manager may correct a line's mapping (same
  -- audit events, duplicate-name guard, and vendor-memory rules as any
  -- approval); the preparer is rejected -- no self-review. The trigger
  -- capability is granted only for this window, so VERIFIED/DISCARDED
  -- stay locked exactly as before.
  if v_purchase_document.status = 'READY_FOR_VERIFICATION' then
    if v_purchase_document.created_by_app_user_id = p_app_user_id then
      raise exception 'app_user % prepared purchase_document % and cannot review-correct its item resolution', p_app_user_id, p_purchase_document_id
        using errcode = 'GA004';
    end if;
    -- Reviewer item-resolution corrections are PROPOSALS
    -- (purchase_document_review_proposals) promoted atomically by Final
    -- Verify -- the only caller that sets this transaction-local
    -- promotion flag. A direct approval during final review, even by the
    -- legitimate reviewer, must never become authoritative on its own.
    if coalesce(current_setting('gansevoort.purchase_document_review_promotion', true), '') <> 'true' then
      raise exception 'purchase_document % is in final review: reviewer item-resolution corrections are proposals applied atomically by Final Verify, never direct writes', p_purchase_document_id
        using errcode = 'GA003';
    end if;
    perform set_config('gansevoort.purchase_document_ready_write', 'true', true);
  end if;

  select vendor_sku, description, package_unit, measured_unit
    into v_line
    from public.purchase_document_lines
   where purchase_document_id = p_purchase_document_id
     and line_key = p_line_key
     and organization_id = p_organization_id;

  if not found then
    raise exception 'line % not found on the current revision of purchase_document %', p_line_key, p_purchase_document_id
      using errcode = 'GA011';
  end if;

  select vendor_id into v_vendor_id
    from public.purchase_documents
   where id = p_purchase_document_id and organization_id = p_organization_id;

  if p_disposition = 'INVENTORY' then
    select id into v_base_unit_id from public.units where code = p_base_unit_code;
    if v_base_unit_id is null then
      raise exception 'unknown unit code %', p_base_unit_code;
    end if;
  end if;

  if p_disposition = 'INVENTORY' and p_purchase_unit_code is not null and p_purchase_unit_code <> p_base_unit_code then
    select id into v_purchase_unit_id from public.units where code = p_purchase_unit_code;
    if v_purchase_unit_id is null then
      raise exception 'unknown unit code %', p_purchase_unit_code;
    end if;

    if p_receiving_behavior = 'FIXED_CONVERSION' and (p_fixed_conversion_factor is null or p_fixed_conversion_factor <= 0) then
      raise exception 'a positive fixed_conversion_factor is required for FIXED_CONVERSION';
    end if;
  end if;

  -- Exact-normalized-duplicate protection (20260811100060) -- excludes
  -- the row being finalized itself (the p_pending_item_id case is still
  -- "the same item," not a duplicate of itself).
  select id, name into v_duplicate
    from public.inventory_items
   where organization_id = p_organization_id
     and status = 'active'
     and approval_status = 'CONFIRMED'
     and public.normalize_item_name(name) = public.normalize_item_name(p_final_name)
     and id is distinct from coalesce(p_pending_item_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if found then
    raise exception 'an active item named "%" already exists -- use it instead of creating a duplicate', v_duplicate.name
      using errcode = 'GA016', detail = jsonb_build_object('existingItemId', v_duplicate.id, 'existingItemName', v_duplicate.name)::text;
  end if;

  if p_pending_item_id is not null then
    -- AI already proposed this item -- confirm THAT row (with the
    -- manager's possibly-edited final values), never create a duplicate.
    update public.inventory_items as ii
       set name = p_final_name,
           disposition = p_disposition,
           category_id = case when p_disposition = 'INVENTORY' then p_category_id else null end,
           spend_category_id = p_spend_category_id,
           base_unit_id = v_base_unit_id,
           approval_status = 'CONFIRMED'
     where ii.id = p_pending_item_id
       and ii.organization_id = p_organization_id
       and ii.approval_status = 'PENDING_REVIEW'
     returning ii.id into v_item_id;

    if not found then
      raise exception 'inventory_item % is not a pending proposal', p_pending_item_id
        using errcode = 'GA009';
    end if;
  else
    v_item_id := gen_random_uuid();
    insert into public.inventory_items (
      id, organization_id, category_id, name, base_unit_id, status,
      disposition, spend_category_id, approval_status, created_via
    ) values (
      v_item_id, p_organization_id,
      case when p_disposition = 'INVENTORY' then p_category_id else null end,
      p_final_name, v_base_unit_id, 'active',
      p_disposition, p_spend_category_id, 'CONFIRMED', 'MANUAL'
    );
  end if;

  -- Self-referencing base-unit row -- INVENTORY disposition only, only at
  -- confirmation time. A PENDING_REVIEW item never has one (see
  -- 20260811100035's comment on why that structurally blocks withdrawal).
  if p_disposition = 'INVENTORY' and not exists (
    select 1 from public.inventory_item_units where inventory_item_id = v_item_id and unit_id = v_base_unit_id
  ) then
    insert into public.inventory_item_units (
      inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
    ) values (
      v_item_id, v_base_unit_id, 1, false, true, true
    );
  end if;

  -- Distinct vendor-purchase-unit row -- only when it's genuinely a
  -- different unit from the base unit. SAME_UNIT (or no purchase unit
  -- supplied at all) needs nothing further; the base-unit row already
  -- covers it.
  if v_purchase_unit_id is not null and p_receiving_behavior is distinct from 'SAME_UNIT' then
    if not exists (select 1 from public.inventory_item_units where inventory_item_id = v_item_id and unit_id = v_purchase_unit_id) then
      insert into public.inventory_item_units (
        inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, is_active
      ) values (
        v_item_id, v_purchase_unit_id,
        case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
        p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY'),
        false, true
      );
    else
      update public.inventory_item_units
         set conversion_factor = case when p_receiving_behavior = 'FIXED_CONVERSION' then p_fixed_conversion_factor else null end,
             requires_actual_measurement = p_receiving_behavior in ('MEASURE_EACH_DELIVERY', 'COUNT_EACH_DELIVERY')
       where inventory_item_id = v_item_id and unit_id = v_purchase_unit_id;
    end if;
  end if;

  insert into public.purchase_document_line_classifications (
    id, organization_id, purchase_document_id, line_key, disposition,
    inventory_item_id, spend_category_id, resolution_source, status,
    resolved_against_snapshot, resolved_by_app_user_id, resolved_at
  ) values (
    gen_random_uuid(), p_organization_id, p_purchase_document_id, p_line_key, p_disposition,
    v_item_id, p_spend_category_id, 'MANUAL', 'CONFIRMED',
    jsonb_build_object('vendorSku', v_line.vendor_sku, 'description', v_line.description, 'packageUnit', v_line.package_unit, 'measuredUnit', v_line.measured_unit),
    p_app_user_id, now()
  )
  on conflict (organization_id, purchase_document_id, line_key) do update set
    disposition = excluded.disposition,
    inventory_item_id = excluded.inventory_item_id,
    spend_category_id = excluded.spend_category_id,
    resolution_source = excluded.resolution_source,
    status = excluded.status,
    resolved_against_snapshot = excluded.resolved_against_snapshot,
    resolved_by_app_user_id = excluded.resolved_by_app_user_id,
    resolved_at = excluded.resolved_at
  returning id into v_classification_id;

  if p_remember_vendor_mapping and v_vendor_id is not null then
    if v_line.vendor_sku is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'VENDOR_SKU', v_line.vendor_sku, null, v_item_id, p_app_user_id
      );
    elsif v_line.description is not null then
      perform public.upsert_vendor_item_mapping(
        p_organization_id, v_vendor_id, 'NORMALIZED_DESCRIPTION', null,
        upper(regexp_replace(btrim(v_line.description), '\s+', ' ', 'g')), v_item_id, p_app_user_id
      );
    end if;
  end if;

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'ITEM_PROPOSAL_APPROVED', 'inventory_item', v_item_id,
    jsonb_build_object(
      'name', p_final_name, 'disposition', p_disposition,
      'purchaseUnitCode', p_purchase_unit_code, 'receivingBehavior', p_receiving_behavior, 'fixedConversionFactor', p_fixed_conversion_factor
    ));

  insert into public.audit_events (organization_id, actor_app_user_id, action, entity_type, entity_id, after_state)
  values (p_organization_id, p_app_user_id, 'LINE_CLASSIFICATION_CONFIRMED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('lineKey', p_line_key, 'inventoryItemId', v_item_id, 'newItem', true));

  return query select v_item_id, v_classification_id;
end;
$$;

-- ============================================================
-- 4. verify_purchase_document: atomic overlay promotion
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
-- 5. return_purchase_document_to_draft: preserve + discard overlay
-- ============================================================
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

  if v_created_by = p_app_user_id then
    raise exception 'app_user % prepared purchase_document % and cannot return it to draft', p_app_user_id, p_purchase_document_id
      using errcode = 'GA004';
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
    raise exception 'purchase_document % could not be returned to draft: not READY_FOR_VERIFICATION, or the version is stale', p_purchase_document_id
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

  -- Unpromoted reviewer proposals are preserved for the audit trail
  -- (visible history of what the reviewer had flagged) but NEVER become
  -- Manager 1's draft state -- the snapshot restore above is complete
  -- and the provisional overlay row is discarded.
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
    p_organization_id, p_app_user_id, 'PURCHASE_DOCUMENT_RETURNED', 'purchase_document', p_purchase_document_id,
    jsonb_build_object('version', p_expected_version, 'reason', p_reason) || v_overlay_note
  );

  return query select p_purchase_document_id, 'DRAFT'::text, v_new_version;
end;
$$;

revoke all on function public.return_purchase_document_to_draft(uuid, uuid, uuid, integer, text) from public;
grant execute on function public.return_purchase_document_to_draft(uuid, uuid, uuid, integer, text) to service_role;
